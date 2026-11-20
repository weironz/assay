import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { cleanHtml } from '../common/sanitize';
import { NotificationsService } from '../notifications/notifications.service';
import { SlaService } from '../sla/sla.service';
import { AttachmentsService } from '../attachments/attachments.service';
import {
  assertAttachmentReferencesAvailable,
  linkReferencedAttachments,
  lockAttachments,
  referencedAttachmentIds,
} from '../attachments/rules';
import {
  canOperateTicket,
  canViewTicket,
  isInternalParticipant,
  isTicketCollaborator,
} from './visibility';
import {
  AUTHOR_SELECT,
  notifyMany,
  PARTICIPANT_USER_SELECT,
  writeHistory,
} from './core';
import { CreateMessageDto, UpdateMessageDto } from './dto';

/**
 * 工单消息域：公开回复/内部备注、@提及、编辑正文。
 * 注册为 TicketsModule provider，由 TicketsService 构造器注入并委派。
 */
@Injectable()
export class TicketMessaging {
  private readonly logger = new Logger(TicketMessaging.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly sla: SlaService,
    private readonly attachments: AttachmentsService,
  ) {}

  async addMessage(user: AuthUser, id: string, dto: CreateMessageDto) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    const canComment = canOperateTicket(user, ticket) || isTicketCollaborator(user, ticket);
    if (!canComment) throw new ForbiddenException('无权回复');

    const isInternal = !!dto.isInternal && isInternalParticipant(user, ticket);
    const allowedMentionIds = new Set([
      ticket.requesterId,
      ...(ticket.assigneeId ? [ticket.assigneeId] : []),
      ...ticket.participants.map((participant) => participant.userId),
    ]);
    const mentionUserIds = [
      ...new Set((dto.mentionUserIds ?? []).filter((id) => id !== user.id)),
    ];
    if (mentionUserIds.some((mentionId) => !allowedMentionIds.has(mentionId))) {
      throw new BadRequestException('只能提及本工单的相关人员');
    }

    // 消息与附件绑定同一事务提交：内部/公开的可见性从落库那一刻起就是确定的。
    const body = cleanHtml(dto.body);
    const references = referencedAttachmentIds(body);
    const { message, firstResponse } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR KEY SHARE`;
      await lockAttachments(tx, references);
      await assertAttachmentReferencesAvailable(tx, user, references);
      const created = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorId: user.id,
          type: isInternal ? 'NOTE' : 'REPLY',
          isInternal,
          contentType: dto.contentType ?? 'text/html',
          body,
          mentions: mentionUserIds.length
            ? { createMany: { data: mentionUserIds.map((userId) => ({ userId })) } }
            : undefined,
        },
        include: {
          author: { select: AUTHOR_SELECT },
          mentions: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
        },
      });
      await linkReferencedAttachments(tx, id, created.id, created.body, user.id);
      await writeHistory(tx, id, user.id, 'MESSAGE', 'message', null, isInternal ? '内部备注' : '回复');
      // Only the first committed public staff reply sets the timestamp.
      const firstResponse = !ticket.firstResponseAt && !isInternal && ticket.requesterId !== user.id
        ? await tx.ticket.updateMany({
            where: { id, firstResponseAt: null },
            data: { firstResponseAt: created.createdAt },
          })
        : null;
      return { message: created, firstResponse: !!firstResponse?.count };
    }, { isolationLevel: 'ReadCommitted' });

    if (firstResponse)
      void this.sla.cancel(id, 'response').catch(error => this.logger.warn('Response SLA cancellation failed for ' + id, error));

    const collaboratorIds = ticket.participants
      .filter((participant) => participant.role === 'COLLABORATOR')
      .map((participant) => participant.userId);
    const followerIds = ticket.participants
      .filter((participant) => participant.role === 'FOLLOWER')
      .map((participant) => participant.userId);
    const recipients = isInternal
      ? [ticket.assigneeId, ...collaboratorIds]
      : [ticket.requesterId, ticket.assigneeId, ...collaboratorIds, ...followerIds];
    const title = isInternal ? '工单有新的内部讨论' : '工单有新回复';
    await Promise.all([
      notifyMany(this.notifications, recipients.filter((uid): uid is string => !!uid),
        user.id, 'MESSAGE', `${title}：${ticket.ticketNo}`, ticket.title, id),
      notifyMany(this.notifications, mentionUserIds,
        user.id, 'MENTION', `有人在工单中提及你：${ticket.ticketNo}`, ticket.title, id),
    ]).catch(error => this.logger.warn('Reply notification failed for ' + id, error));
    return message;
  }

  /** 编辑消息（仅限消息原作者本人） */
  async updateMessage(
    user: AuthUser,
    ticketId: string,
    messageId: string,
    dto: UpdateMessageDto,
  ) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { participants: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    // 写权限必须建立在「当前仍能查看该工单」之上：被 removeParticipant 移出的
    // 协作成员不能再改写自己的历史消息，否则移除协作只挡住了新回复。
    // 这里是快速失败；真正写库前会在同一事务里再确认一次，避免读取与写入之间
    // 被移出协作。
    if (!canViewTicket(user, ticket)) {
      throw new ForbiddenException('无权查看该工单');
    }

    const body = cleanHtml(dto.body);
    const after = referencedAttachmentIds(body);
    // 正文、附件绑定、删除队列和审计一起提交，存储操作在提交之后执行。
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId} FOR KEY SHARE`;
      const current = await tx.ticket.findUnique({
        where: { id: ticketId },
        include: { participants: true },
      });
      if (!current) throw new NotFoundException('工单不存在');
      if (!canViewTicket(user, current)) {
        throw new ForbiddenException('无权查看该工单');
      }
      const canSeeInternal = isInternalParticipant(user, current);

      // 把编辑权限下推到消息查询里：先取正文、再在内存里判断，会让无权用户
      // 触发一次内部备注正文的读取，也容易在后续改动中漏掉校验。作者归属
      // 必须恒等下推，任何角色（含 admin/supervisor）都不能编辑他人消息。
      const authorized = await tx.ticketMessage.findFirst({
        where: {
          id: messageId,
          ticketId,
          authorId: user.id,
          ...(canSeeInternal ? {} : { isInternal: false }),
        },
        select: { id: true, body: true, revision: true },
      });
      if (!authorized) {
        // 只在确认存在后返回 403，不把无权访问的消息正文带出来。
        const meta = await tx.ticketMessage.findFirst({
          where: { id: messageId, ticketId },
          select: { authorId: true, isInternal: true },
        });
        if (!meta) throw new NotFoundException('消息不存在');
        if (meta.authorId !== user.id) {
          throw new ForbiddenException('只能编辑自己的消息');
        }
        if (meta.isInternal && !canSeeInternal) {
          throw new ForbiddenException('无权编辑内部备注');
        }
        throw new ForbiddenException('无权编辑该消息');
      }

      if (dto.revision !== authorized.revision) throw new ConflictException('消息已变更，请刷新后重试');
      const before = referencedAttachmentIds(authorized.body);
      await lockAttachments(tx, [...before, ...after]);
      await assertAttachmentReferencesAvailable(tx, user, [...after].filter(id => !before.has(id)));
      const next = await tx.ticketMessage.update({
        where: { id: authorized.id, revision: dto.revision },
        data: { body },
        include: { author: { select: AUTHOR_SELECT } },
      }).catch(error => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new ConflictException('消息已变更，请刷新后重试');
        }
        throw error;
      });
      await linkReferencedAttachments(tx, ticketId, messageId, next.body, user.id);
      const queued = before.size ? await this.attachments.queueRemovedInlineImages(
        tx, ticketId, messageId, user.id, authorized.body, next.body,
      ) : 0;
      await writeHistory(tx, ticketId, user.id, 'UPDATE', 'message', null, '编辑消息');
      return { next, queued };
    }, { isolationLevel: 'ReadCommitted' });
    if (result.queued) void this.attachments.processPendingDeletions().catch(() => undefined);
    return result.next;
  }
}
