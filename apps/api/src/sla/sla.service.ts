import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const SLA_QUEUE = 'sla';

/** 调度/取消工单 SLA 超时检查任务（BullMQ 延时任务） */
@Injectable()
export class SlaService {
  private readonly logger = new Logger('SLA');

  constructor(@InjectQueue(SLA_QUEUE) private readonly queue: Queue) {}

  /** 在 dueAt 时刻检查该工单是否超时；重复调用会覆盖旧任务 */
  async schedule(ticketId: string, dueAt: Date) {
    await this.cancel(ticketId);
    const delay = Math.max(0, dueAt.getTime() - Date.now());
    await this.queue.add(
      'check',
      { ticketId },
      { delay, jobId: ticketId, removeOnComplete: true, removeOnFail: true },
    );
    this.logger.log(`已调度 SLA 检查 ticket=${ticketId} delay=${Math.round(delay / 1000)}s`);
  }

  async cancel(ticketId: string) {
    try {
      const job = await this.queue.getJob(ticketId);
      if (job) await job.remove();
    } catch {
      /* ignore */
    }
  }
}
