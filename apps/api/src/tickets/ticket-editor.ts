import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { cleanHtml } from '../common/sanitize';
import {
  assertAttachmentReferencesAvailable,
  assertAttachmentSlots,
  linkReferencedAttachments,
  lockAttachments,
  referencedAttachmentIds,
} from '../attachments/rules';
import { enqueueObjectDeletions } from '../attachments/deletion-queue';
import { SlaService } from '../sla/sla.service';
import { canOperateTicket } from './visibility';
import {
  assertValidReference,
  allocateTicketNo,
  loadTicketOrThrow,
  normalizeContact,
  resolveCategoryId,
  slaOf,
  writeHistory,
} from './core';
import { CreateTicketDto, UpdateTicketDto } from './dto';
import { DEFAULT_QUEUE, DEFAULT_TICKET_TYPE } from './presets';

/**
 * 工单写域 - 建单与编辑。注册为 TicketsModule provider，由 TicketsService 构造器注入并委派。
 * 返回值为工单 id，详情重读由外观层统一走查询域（测试可整体 stub）。
 */
@Injectable()
export class TicketEditor {
  private readonly logger = new Logger(TicketEditor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sla: SlaService,
  ) {}

  async create(user: AuthUser, dto: CreateTicketDto): Promise<string> {
    const body = cleanHtml(dto.body);
    const references = referencedAttachmentIds(body);
    const contact = normalizeContact(dto.contact);
    const attachmentIds = [...new Set(dto.attachmentIds ?? [])].sort();
    const requested = {
      title: dto.title, body, priority: dto.priority ?? 'MEDIUM',
      typeId: dto.typeId, categoryId: dto.categoryId,
      categoryName: dto.categoryName?.trim(), datacenterId: dto.datacenterId,
      clusterId: dto.clusterId, serialNumber: dto.serialNumber?.trim() || null,
      contact, saveContactAsDefault: !!dto.saveContactAsDefault, attachmentIds,
    };
    const request = dto.idempotencyKey && {
      requesterId: user.id, key: dto.idempotencyKey,
      requestHash: createHash('sha256').update(JSON.stringify(requested)).digest('hex'),
    };
    const replay = async () => {
      if (!request) return;
      const { requesterId, key, requestHash } = request;
      const previous = await this.prisma.ticketCreationRequest.findUnique({
        where: { requesterId_key: { requesterId, key } },
      });
      if (!previous) return;
      if (previous.requestHash !== requestHash) throw new ConflictException('此建单请求编号已用于其他内容');
      if (!previous.ticketId) throw new ConflictException('此请求对应的工单已删除');
      return previous.ticketId;
    };
    const previous = await replay();
    if (previous) return previous;

    const [typeId, queueId] = await Promise.all([
      dto.typeId ?? this.defaultTypeId(),
      this.defaultQueueId(),
    ]);
    const ticket = await this.prisma.$transaction(async (tx) => {
      if (request) await tx.ticketCreationRequest.create({ data: request });
      await lockAttachments(tx, [...references, ...attachmentIds]);
      await assertAttachmentReferencesAvailable(tx, user, references);

      const categoryId = await resolveCategoryId(tx, dto.categoryId, dto.categoryName);
      const sla = await slaOf(tx, typeId);
      const createdAt = new Date();
      const ticketNo = await allocateTicketNo(tx, createdAt);
      const created = await tx.ticket.create({
        data: {
          ticketNo,
          title: dto.title,
          requesterId: user.id,
          priority: requested.priority,
          typeId,
          categoryId,
          queueId,
          datacenterId: dto.datacenterId,
          clusterId: dto.clusterId,
          serialNumber: requested.serialNumber,
          contact,
          createdAt,
          firstResponseDueAt: new Date(createdAt.getTime() + sla.responseMin * 60_000),
          slaDueAt: new Date(createdAt.getTime() + sla.resolveMin * 60_000),
          status: 'NEW',
          messages: { create: { authorId: user.id, body, contentType: 'text/html' } },
        },
      });

      if (references.size || attachmentIds.length) {
        const first = await tx.ticketMessage.findFirstOrThrow({
          where: { ticketId: created.id }, orderBy: { createdAt: 'asc' }, select: { id: true },
        });
        const drafts = await this.bindDrafts(tx, user.id, created.id, first.id, attachmentIds, references);
        const inline = await linkReferencedAttachments(tx, created.id, first.id, body, user.id);
        if (drafts || inline) await assertAttachmentSlots(tx, created.id);
      }
      await writeHistory(tx, created.id, user.id, 'CREATE', 'status', null, 'NEW');
      if (dto.saveContactAsDefault && dto.contact?.phone?.trim()) {
        await tx.user.update({ where: { id: user.id }, data: { defaultContact: contact } });
      }
      if (request) await tx.ticketCreationRequest.update({
        where: { requesterId_key: { requesterId: request.requesterId, key: request.key } },
        data: { ticketId: created.id },
      });
      return created;
    }, { isolationLevel: 'ReadCommitted' }).catch(async error => {
      if (request && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const repeated = await replay();
        if (repeated) return repeated;
      }
      throw error;
    });
    if (typeof ticket === 'string') return ticket;

    // The reconciliation worker can restore either job from the committed deadline.
    void Promise.all([
      this.sla.schedule(ticket.id, 'response', ticket.firstResponseDueAt),
      this.sla.schedule(ticket.id, 'resolve', ticket.slaDueAt),
    ]).catch(error => this.logger.warn('SLA scheduling will be reconciled for ' + ticket.id, error));
    return ticket.id;
  }

  /** The caller has locked all selected draft rows before inspecting references. */
  private async bindDrafts(
    tx: Prisma.TransactionClient, uploaderId: string, ticketId: string,
    messageId: string, ids: string[], references: ReadonlySet<string>,
  ) {
    if (!ids.length) return 0;
    const unreferencedIds = ids.filter(id => !references.has(id));
    const discarded = unreferencedIds.length ? await tx.ticketAttachment.findMany({
      where: { id: { in: unreferencedIds }, uploaderId, ticketId: null, messageId: null, isInline: true },
      select: { id: true, objectKey: true },
    }) : [];
    const discardedIds = discarded.map(row => row.id);
    if (discardedIds.length) {
      // A historical draft with references cannot safely be deleted or rebound.
      const used = await tx.ticketAttachmentReference.findMany({
        where: { attachmentId: { in: discardedIds } }, select: { attachmentId: true },
      });
      const usedIds = new Set(used.map(row => row.attachmentId));
      const unused = discarded.filter(row => !usedIds.has(row.id));
      if (unused.length) {
        await tx.ticketAttachment.deleteMany({ where: { id: { in: unused.map(row => row.id) } } });
        await enqueueObjectDeletions(tx, unused.map(row => row.objectKey), 'INLINE_DRAFT_DISCARDED');
      }
    }
    const keep = ids.filter(id => !discardedIds.includes(id));
    if (!keep.length) return 0;
    const bound = await tx.ticketAttachment.updateMany({
      where: { id: { in: keep }, uploaderId, ticketId: null, messageId: null },
      data: { ticketId, messageId },
    });
    return bound.count;
  }

  private async defaultTypeId() {
    const where = { name: DEFAULT_TICKET_TYPE.name };
    const select = { id: true };
    const type = await this.prisma.ticketType.findUnique({ where, select });
    // An unseeded database can still accept a ticket. Keep existing SLA settings.
    return (type ?? await this.prisma.ticketType.upsert({
      where, select, create: DEFAULT_TICKET_TYPE, update: { name: where.name },
    })).id;
  }

  private async defaultQueueId() {
    const where = { name: DEFAULT_QUEUE.name };
    const select = { id: true };
    const queue = await this.prisma.queue.findUnique({ where, select });
    return (queue ?? await this.prisma.queue.upsert({
      where, select, create: DEFAULT_QUEUE, update: { name: where.name },
    })).id;
  }

  async update(user: AuthUser, id: string, dto: UpdateTicketDto): Promise<string> {
    const ticket = await loadTicketOrThrow(this.prisma, id);
    if (!canOperateTicket(user, ticket)) throw new ForbiddenException('无权操作');
    if (dto.title !== undefined && !dto.title?.trim()) throw new BadRequestException('标题不能为空');
    if (dto.categoryName !== undefined && !dto.categoryId && !dto.categoryName?.trim()) throw new BadRequestException('分类名称不能为空');
    await this.prisma.$transaction(async (database) => {
      // Recheck ownership inside the same transaction as the change and audit.
      const before = await database.ticket.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('工单不存在');
      if (!canOperateTicket(user, before)) throw new ForbiddenException('无权操作');
      const references = [
        { field: 'typeId', value: dto.typeId, find: () => database.ticketType.findUnique({ where: { id: dto.typeId! } }) },
        { field: 'categoryId', value: dto.categoryId, find: () => database.category.findUnique({ where: { id: dto.categoryId! } }) },
        { field: 'datacenterId', value: dto.datacenterId, find: () => database.datacenter.findUnique({ where: { id: dto.datacenterId! } }) },
        { field: 'clusterId', value: dto.clusterId, find: () => database.cluster.findUnique({ where: { id: dto.clusterId! } }) },
      ];
      for (const reference of references) {
        await assertValidReference(reference.field, reference.value, reference.find);
      }
      const data = {
        title: dto.title?.trim(), priority: dto.priority, typeId: dto.typeId,
        categoryId: dto.categoryName !== undefined && !dto.categoryId
          ? await resolveCategoryId(database, undefined, dto.categoryName) : dto.categoryId,
        datacenterId: dto.datacenterId, clusterId: dto.clusterId,
        serialNumber: dto.serialNumber === undefined ? undefined : dto.serialNumber?.trim() || null,
        contact: dto.contact === undefined ? undefined : normalizeContact(dto.contact),
      };
      const serialize = (value: unknown): string | null => value == null || value === Prisma.JsonNull ? null : typeof value === 'string' ? value : JSON.stringify(value);
      const changes = Object.entries(data).filter(([field, value]) => value !== undefined && serialize(before[field as keyof typeof before]) !== serialize(value));
      if (!changes.length) return;
      await database.ticket.update({ where: { id }, data });
      for (const [field, value] of changes) {
        await database.ticketHistory.create({ data: {
          ticketId: id, userId: user.id, action: 'UPDATE', field,
          oldValue: serialize(before[field as keyof typeof before]), newValue: serialize(value),
        } });
      }
    });
    return id;
  }
}
