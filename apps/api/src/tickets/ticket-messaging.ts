import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { cleanHtml } from '../common/sanitize';
import { NotificationsService } from '../notifications/notifications.service';
import { SlaService } from '../sla/sla.service';
import { linkReferencedAttachments } from '../attachments/rules';
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
import { CreateMessageDto } from './dto';

/**
 * 工单消息域：公开回复/内部备注、@提及、编辑正文。
 * 注册为 TicketsModule provider，由 TicketsService 构造器注入并委派。
 */
@Injectable()
export class TicketMessaging {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly sla: SlaService,
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
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorId: user.id,
          type: isInternal ? 'NOTE' : 'REPLY',
          isInternal,
          contentType: dto.contentType ?? 'text/html',
          body: cleanHtml(dto.body),
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
      return created;
    });
    await writeHistory(this.prisma, id, user.id, 'MESSAGE', 'message', null, isInternal ? '内部备注' : '回复');

    // 首次由非提单人发出的公开回复 → 记 first_response，并撤掉响应超时任务
    if (!ticket.firstResponseAt && !isInternal && ticket.requesterId !== user.id) {
      await this.prisma.ticket.update({
        where: { id },
        data: { firstResponseAt: new Date() },
      });
      await this.sla.cancel(id, 'response');
    }

    const collaboratorIds = ticket.participants
      .filter((participant) => participant.role === 'COLLABORATOR')
      .map((participant) => participant.userId);
    const followerIds = ticket.participants
      .filter((participant) => participant.role === 'FOLLOWER')
      .map((participant) => participant.userId);
    if (isInternal) {
      // 内部讨论不泄露给提单人和仅关注者。
      await notifyMany(
        this.notifications,
        [ticket.assigneeId, ...collaboratorIds].filter(Boolean) as string[],
        user.id,
        'MESSAGE',
        `工单有新的内部讨论：${ticket.ticketNo}`,
        ticket.title,
        id,
      );
    } else {
      await notifyMany(
        this.notifications,
        [ticket.requesterId, ticket.assigneeId, ...collaboratorIds, ...followerIds].filter(
          Boolean,
        ) as string[],
        user.id,
        'MESSAGE',
        `工单有新回复：${ticket.ticketNo}`,
        ticket.title,
        id,
      );
    }
    await notifyMany(
      this.notifications,
      mentionUserIds,
      user.id,
      'MENTION',
      `有人在工单中提及你：${ticket.ticketNo}`,
      ticket.title,
      id,
    );
    return message;
  }

  /** 编辑消息（作者本人或 admin/supervisor） */
  async updateMessage(
    user: AuthUser,
    ticketId: string,
    messageId: string,
    dto: CreateMessageDto,
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

    // 编辑同样可能引入新的附件引用，更新正文与绑定必须原子提交。
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.ticket.findUnique({
        where: { id: ticketId },
        include: { participants: true },
      });
      if (!current) throw new NotFoundException('工单不存在');
      if (!canViewTicket(user, current)) {
        throw new ForbiddenException('无权查看该工单');
      }
      const isStaff =
        user.roles.includes('admin') || user.roles.includes('supervisor');
      const canSeeInternal = isInternalParticipant(user, current);

      // 把编辑权限下推到消息查询里：先取正文、再在内存里判断，会让无权用户
      // 触发一次内部备注正文的读取，也容易在后续改动中漏掉校验。
      const authorized = await tx.ticketMessage.findFirst({
        where: {
          id: messageId,
          ticketId,
          ...(isStaff ? {} : { authorId: user.id }),
          ...(canSeeInternal ? {} : { isInternal: false }),
        },
        select: { id: true },
      });
      if (!authorized) {
        // 只在确认存在后返回 403，不把无权访问的消息正文带出来。
        const meta = await tx.ticketMessage.findFirst({
          where: { id: messageId, ticketId },
          select: { authorId: true, isInternal: true },
        });
        if (!meta) throw new NotFoundException('消息不存在');
        if (meta.authorId !== user.id && !isStaff) {
          throw new ForbiddenException('只能编辑自己的消息');
        }
        if (meta.isInternal && !canSeeInternal) {
          throw new ForbiddenException('无权编辑内部备注');
        }
        throw new ForbiddenException('无权编辑该消息');
      }

      const next = await tx.ticketMessage.update({
        where: { id: authorized.id },
        data: { body: cleanHtml(dto.body) },
        include: { author: { select: AUTHOR_SELECT } },
      });
      await linkReferencedAttachments(tx, ticketId, messageId, next.body, user.id);
      return next;
    });
    await writeHistory(this.prisma, ticketId, user.id, 'UPDATE', 'message', null, '编辑消息');
    return updated;
  }
}
