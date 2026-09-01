import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SLA_QUEUE, SlaKind } from './sla.service';

/** 优先级升级顺序 */
const PRIORITY_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/** SLA 超时任务处理器：到期检查工单是否仍未响应/未解决，超时则通知 */
@Processor(SLA_QUEUE)
export class SlaProcessor extends WorkerHost {
  private readonly logger = new Logger('SLAWorker');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ ticketId: string; kind: SlaKind }>) {
    const { ticketId, kind } = job.data;
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) return;

    // 终态不算超时
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) return;
    // 挂起期间不计时：正常流程下挂起时任务已被取消，这里是兜底
    if (ticket.status === 'PENDING') return;

    if (kind === 'response') {
      if (ticket.firstResponseAt) return; // 已经响应过
      await this.onResponseOverdue(ticket);
    } else {
      await this.onResolveOverdue(ticket);
    }
  }

  /**
   * 首次响应超时。收件人挑得比解决超时更讲究：
   * 已指派就通知处理人；没人接手才是最危险的情况，这时通知管理员和主管，
   * 否则这条告警会没有任何人看到。
   */
  private async onResponseOverdue(ticket: {
    id: string;
    ticketNo: string;
    title: string;
    assigneeId: string | null;
  }) {
    this.logger.warn(`响应超时 ${ticket.ticketNo}`);

    let targets: string[];
    if (ticket.assigneeId) {
      targets = [ticket.assigneeId];
    } else {
      const staff = await this.prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          roles: { some: { role: { name: { in: ['admin', 'supervisor'] } } } },
        },
        select: { id: true },
      });
      targets = staff.map((u) => u.id);
    }

    for (const uid of targets) {
      await this.notifications.notify(uid, {
        type: 'SLA_RESPONSE_OVERDUE',
        title: `⏰ 工单超时未响应：${ticket.ticketNo}`,
        content: `「${ticket.title}」已超过首次响应时限仍无人回复。`,
        ticketId: ticket.id,
      });
    }
    await this.systemHistory(ticket.id, 'sla', null, '首次响应超时');
  }

  private async onResolveOverdue(ticket: {
    id: string;
    ticketNo: string;
    title: string;
    priority: string;
    assigneeId: string | null;
    requesterId: string;
  }) {
    this.logger.warn(`解决超时 ${ticket.ticketNo}`);

    const targets = new Set(
      [ticket.assigneeId, ticket.requesterId].filter(Boolean) as string[],
    );
    for (const uid of targets) {
      await this.notifications.notify(uid, {
        type: 'SLA_OVERDUE',
        title: `⏰ 工单已超时：${ticket.ticketNo}`,
        content: `「${ticket.title}」已超过 SLA 解决时限仍未完成，请尽快处理。`,
        ticketId: ticket.id,
      });
    }
    await this.systemHistory(ticket.id, 'sla', null, '解决超时');

    // 自动升级优先级（未到 URGENT 则提升一级），并留痕——
    // 否则用户会莫名发现优先级自己变了，历史里却查不到是谁改的
    const idx = PRIORITY_ORDER.indexOf(ticket.priority);
    if (idx >= 0 && idx < PRIORITY_ORDER.length - 1) {
      const next = PRIORITY_ORDER[idx + 1];
      await this.prisma.ticket.update({
        where: { id: ticket.id },
        data: { priority: next as never },
      });
      await this.systemHistory(ticket.id, 'priority', ticket.priority, next);
    }
  }

  /** userId 留空表示系统操作，界面显示为「系统」 */
  private systemHistory(
    ticketId: string,
    field: string,
    oldValue: string | null,
    newValue: string,
  ) {
    return this.prisma.ticketHistory.create({
      data: { ticketId, userId: null, action: 'UPDATE', field, oldValue, newValue },
    });
  }
}
