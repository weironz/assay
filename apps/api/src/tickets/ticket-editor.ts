import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { cleanHtml } from '../common/sanitize';
import {
  assertAttachmentReferencesAvailable,
  linkReferencedAttachments,
  lockAttachments,
  referencedAttachmentIds,
} from '../attachments/rules';
import { SlaService } from '../sla/sla.service';
import { canOperateTicket } from './visibility';
import {
  assertValidReference,
  createWithTicketNo,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly sla: SlaService,
  ) {}

  async create(user: AuthUser, dto: CreateTicketDto): Promise<string> {
    const [typeId, queueId] = await Promise.all([
      dto.typeId ?? this.defaultTypeId(),
      dto.queueId ?? this.defaultQueueId(),
    ]);
    const categoryId = await resolveCategoryId(
      this.prisma,
      dto.categoryId,
      dto.categoryName,
    );
    const body = cleanHtml(dto.body);
    const references = referencedAttachmentIds(body);
    const ticket = await createWithTicketNo(this.prisma, (ticketNo) => this.prisma.$transaction(async (tx) => {
      await lockAttachments(tx, [...references, ...(dto.attachmentIds ?? [])]);
      await assertAttachmentReferencesAvailable(tx, user, references);
      const created = await tx.ticket.create({ data: {
        ticketNo,
        title: dto.title,
        requesterId: user.id,
        priority: dto.priority ?? 'MEDIUM',
        typeId,
        categoryId,
        queueId,
        datacenterId: dto.datacenterId,
        clusterId: dto.clusterId,
        serialNumber: dto.serialNumber?.trim() || null,
        contact: normalizeContact(dto.contact),
        status: 'NEW',
        messages: {
          create: {
            authorId: user.id,
            type: 'REPLY',
            isInternal: false,
            contentType: 'text/html',
            body,
          },
        },
      } });

      if (!references.size && !dto.attachmentIds?.length) return created;
      const firstMessage = await tx.ticketMessage.findFirstOrThrow({
        where: { ticketId: created.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (dto.attachmentIds?.length) {
        await tx.ticketAttachment.updateMany({
          where: { id: { in: dto.attachmentIds }, uploaderId: user.id, ticketId: null },
          data: { ticketId: created.id, messageId: firstMessage.id },
        });
      }
      await linkReferencedAttachments(tx, created.id, firstMessage.id, body, user.id);
      return created;
    }, { isolationLevel: 'ReadCommitted' }));
    // SLA 从建单起算：一直没人接手才是最该告警的情况，
    // 从「开始处理」起算的话这种单永远不会超时
    const sla = await slaOf(this.prisma, typeId);
    const base = ticket.createdAt.getTime();
    const firstResponseDueAt = new Date(base + sla.responseMin * 60_000);
    const slaDueAt = new Date(base + sla.resolveMin * 60_000);
    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { firstResponseDueAt, slaDueAt },
    });
    await this.sla.schedule(ticket.id, 'response', firstResponseDueAt);
    await this.sla.schedule(ticket.id, 'resolve', slaDueAt);

    await writeHistory(this.prisma, ticket.id, user.id, 'CREATE', 'status', null, 'NEW');
    // 勾了「设为默认」才写用户档案；没勾就不动，免得覆盖上次存好的
    if (dto.saveContactAsDefault && dto.contact?.phone?.trim()) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { defaultContact: normalizeContact(dto.contact) },
      });
    }
    return ticket.id;
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
        { field: 'queueId', value: dto.queueId, find: () => database.queue.findUnique({ where: { id: dto.queueId! } }) },
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
        queueId: dto.queueId, datacenterId: dto.datacenterId, clusterId: dto.clusterId,
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
