import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SLA_QUEUE } from './sla.service';

/** SLA 超时任务处理器：到期检查工单是否仍未解决，超时则通知 */
@Processor(SLA_QUEUE)
export class SlaProcessor extends WorkerHost {
  private readonly logger = new Logger('SLAWorker');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ ticketId: string }>) {
    const { ticketId } = job.data;
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) return;

    // 已解决/关闭/取消 则不算超时
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) return;

    this.logger.warn(`工单超时 ${ticket.ticketNo}`);

    const title = `⏰ 工单已超时：${ticket.ticketNo}`;
    const content = `「${ticket.title}」已超过 SLA 解决时限仍未完成，请尽快处理。`;

    // 通知处理人与提单人
    const targets = new Set(
      [ticket.assigneeId, ticket.requesterId].filter(Boolean) as string[],
    );
    for (const uid of targets) {
      await this.notifications.notify(uid, {
        type: 'SLA_OVERDUE',
        title,
        content,
        ticketId,
      });
    }

    // 升级优先级（未到 URGENT 则提升一级）
    const order = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
    const idx = order.indexOf(ticket.priority);
    if (idx >= 0 && idx < order.length - 1) {
      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: { priority: order[idx + 1] as any },
      });
    }
  }
}
