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
  linkReferencedAttachments,
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
    const categoryId = await resolveCategoryId(
      this.prisma,
      dto.categoryId,
      dto.categoryName,
    );
    const ticket = await createWithTicketNo(this.prisma, (ticketNo) => ({
      data: {
        ticketNo,
        title: dto.title,
        requesterId: user.id,
        priority: (dto.priority as any) ?? 'MEDIUM',
        typeId: dto.typeId,
        categoryId,
        queueId: dto.queueId,
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
            body: cleanHtml(dto.body),
          },
        },
      },
    }));
    // SLA 从建单起算：一直没人接手才是最该告警的情况，
    // 从「开始处理」起算的话这种单永远不会超时
    const sla = await slaOf(this.prisma, dto.typeId ?? null);
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
    // 关联建单前上传的草稿附件（仅本人、仍未挂单的）。未绑定附件已收紧为
    // 「仅上传者/内部可见」，所以这里要一次性把归属确定下来：
    // - attachmentIds 是用户在附件区显式选择的文件，绑定到建单首条公开消息；
    // - 正文里实际引用的内联图即使没出现在 attachmentIds 里，也一并挂到工单并
    //   绑定到首条消息，避免正文图片对协作成员和分享页 404。
    await this.prisma.$transaction(async (tx) => {
      if (dto.attachmentIds?.length) {
        await tx.ticketAttachment.updateMany({
          where: {
            id: { in: dto.attachmentIds },
            uploaderId: user.id,
            ticketId: null,
          },
          data: { ticketId: ticket.id },
        });
      }
      const firstMessage = await tx.ticketMessage.findFirst({
        where: { ticketId: ticket.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true },
      });
      if (!firstMessage) return;

      if (dto.attachmentIds?.length) {
        await tx.ticketAttachment.updateMany({
          where: {
            id: { in: dto.attachmentIds },
            ticketId: ticket.id,
            uploaderId: user.id,
            messageId: null,
          },
          data: { messageId: firstMessage.id },
        });
      }
      const referenced = [...referencedAttachmentIds(firstMessage.body)];
      if (referenced.length) {
        // linkReferencedAttachments 会先把不在 attachmentIds 里的草稿图补挂到
        // 工单，再按正文引用绑定 messageId。
        await linkReferencedAttachments(
          tx,
          ticket.id,
          firstMessage.id,
          firstMessage.body,
          user.id,
        );
      }
    });
    return ticket.id;
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
