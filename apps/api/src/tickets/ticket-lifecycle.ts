import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowService, TicketAction } from './workflow.service';
import {
  loadTicketOrThrow,
  notifyMany,
  slaOf,
  ticketParticipantIds,
  writeHistory,
} from './core';
import { AssignDto } from './dto';

/**
 * 工单生命周期域：指派与状态流转（含 SLA 时钟与通知）。
 * 注册为 TicketsModule provider，由 TicketsService 构造器注入并委派。
 */
@Injectable()
export class TicketLifecycle {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowService,
    private readonly notifications: NotificationsService,
    private readonly sla: SlaService,
  ) {}

  async assign(user: AuthUser, id: string, dto: AssignDto): Promise<string> {
    const ticket = await loadTicketOrThrow(this.prisma, id);
    if (!['NEW', 'REOPENED'].includes(ticket.status)) {
      throw new BadRequestException(`当前状态 ${ticket.status} 不可指派`);
    }
    const assignee = await this.prisma.user.findUnique({
      where: { id: dto.assigneeId },
    });
    if (!assignee) throw new BadRequestException('指派对象不存在');

    await this.prisma.ticket.update({
      where: { id },
      data: {
        assigneeId: dto.assigneeId,
        queueId: dto.queueId ?? ticket.queueId,
        status: 'ASSIGNED',
      },
    });
    await writeHistory(
      this.prisma,
      id,
      user.id,
      'ASSIGN',
      'assignee',
      ticket.assigneeId,
      dto.assigneeId,
    );
    await writeHistory(this.prisma, id, user.id, 'TRANSITION', 'status', ticket.status, 'ASSIGNED');
    await this.notifications.notify(dto.assigneeId, {
      type: 'ASSIGNED',
      title: `你被指派了工单：${ticket.ticketNo}`,
      content: ticket.title,
      ticketId: id,
    });
    return id;
  }

  async transition(user: AuthUser, id: string, action: TicketAction): Promise<string> {
    const ticket = await loadTicketOrThrow(this.prisma, id);
    const to = this.workflow.resolveTransition(action, ticket.status, user, ticket);

    const data: Prisma.TicketUpdateInput = { status: to };
    const now = new Date();
    // 计时起点在建单，这里只负责「暂停/恢复/重开」三种对时钟的影响
    let responseDue = ticket.firstResponseDueAt;
    let resolveDue = ticket.slaDueAt;
    let reschedule = false;

    if (to === 'PENDING') {
      // 挂起：记下暂停起点，把两个到期任务撤掉，时钟就停了
      data.holdStartedAt = now;
      await this.sla.cancel(id);
    } else if (ticket.status === 'PENDING' && ticket.holdStartedAt) {
      // 恢复：把这段暂停时长整体加回到两个截止时刻上，等价于时钟从未走过
      const paused = now.getTime() - ticket.holdStartedAt.getTime();
      data.holdStartedAt = null;
      data.holdMs = { increment: paused };
      if (responseDue && !ticket.firstResponseAt) {
        responseDue = new Date(responseDue.getTime() + paused);
        data.firstResponseDueAt = responseDue;
      }
      if (resolveDue) {
        resolveDue = new Date(resolveDue.getTime() + paused);
        data.slaDueAt = resolveDue;
      }
      reschedule = true;
    } else if (to === 'REOPENED') {
      // 重开：旧的解决时限早就过期了，继续用它等于永远超时。按类型重新给一档
      const sla = await slaOf(this.prisma, ticket.typeId);
      resolveDue = new Date(now.getTime() + sla.resolveMin * 60_000);
      data.slaDueAt = resolveDue;
      reschedule = true;
    }

    if (to === 'CLOSED') data.closedAt = now;

    // 乐观并发：状态从读取到写入之间若被并发流转，updateMany 命中 0 行，
    // 拒绝重放（避免双写历史、双加暂停时长、重复调度 SLA）。
    const updated = await this.prisma.ticket.updateMany({
      where: { id, status: ticket.status },
      data,
    });
    if (updated.count === 0)
      throw new ConflictException('工单状态已被其他人变更，请刷新后重试');
    await writeHistory(this.prisma, id, user.id, 'TRANSITION', 'status', ticket.status, to);

    // SLA 任务调度 / 取消
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(to)) {
      await this.sla.cancel(id);
    } else if (reschedule) {
      if (!ticket.firstResponseAt) {
        await this.sla.schedule(id, 'response', responseDue);
      }
      await this.sla.schedule(id, 'resolve', resolveDue);
    }

    // 状态变更通知
    await this.notifyTransition(user, ticket, to);
    return id;
  }

  private async notifyTransition(
    user: AuthUser,
    ticket: { id: string; ticketNo: string; title: string; requesterId: string; assigneeId: string | null },
    to: TicketStatus,
  ) {
    const base = { ticketId: ticket.id, content: ticket.title };
    const notify = (uid: string | null, type: string, title: string) =>
      uid && uid !== user.id
        ? this.notifications.notify(uid, { type, title, ...base })
        : undefined;

    if (to === 'RESOLVED') {
      await notify(ticket.requesterId, 'RESOLVED', `工单已处理待验收：${ticket.ticketNo}`);
    } else if (to === 'CLOSED') {
      await notify(ticket.assigneeId, 'CLOSED', `工单已关闭：${ticket.ticketNo}`);
    } else if (to === 'REOPENED') {
      await notify(ticket.assigneeId, 'REOPENED', `工单被重新打开：${ticket.ticketNo}`);
    } else if (to === 'CANCELLED') {
      await notify(ticket.assigneeId, 'CANCELLED', `工单被取消：${ticket.ticketNo}`);
    }

    // 关注人需要知晓生命周期变化；提单人与主处理人已由上面的精确规则覆盖。
    const participantIds = await ticketParticipantIds(this.prisma, ticket.id);
    await notifyMany(
      this.notifications,
      participantIds,
      user.id,
      'MESSAGE',
      `工单状态已更新：${ticket.ticketNo}`,
      ticket.title,
      ticket.id,
    );
  }
}
