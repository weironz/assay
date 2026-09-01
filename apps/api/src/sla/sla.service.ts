import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const SLA_QUEUE = 'sla';

/** 一张单有两条独立的时限：首次响应、解决完成 */
export type SlaKind = 'response' | 'resolve';

const KINDS: SlaKind[] = ['response', 'resolve'];

/**
 * 一个工单两条时限 → 两个任务，jobId 必须区分开，否则互相顶掉。
 * 分隔符不能用冒号：BullMQ 的自定义 jobId 明确禁止 ':'（它自己用来拼 Redis key）。
 * cuid 只含字母数字，所以短横线不会产生歧义。
 */
const jobIdOf = (ticketId: string, kind: SlaKind) => `${ticketId}-${kind}`;

/** 调度/取消工单 SLA 超时检查任务（BullMQ 延时任务） */
@Injectable()
export class SlaService {
  private readonly logger = new Logger('SLA');

  constructor(@InjectQueue(SLA_QUEUE) private readonly queue: Queue) {}

  /** 在 dueAt 时刻检查该工单是否超时；重复调用会覆盖同类型的旧任务 */
  async schedule(ticketId: string, kind: SlaKind, dueAt: Date | null) {
    await this.cancel(ticketId, kind);
    if (!dueAt) return; // 没有时限（如工单未设类型）就不排任务
    const delay = Math.max(0, dueAt.getTime() - Date.now());
    await this.queue.add(
      'check',
      { ticketId, kind },
      {
        delay,
        jobId: jobIdOf(ticketId, kind),
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    this.logger.log(
      `已调度 SLA[${kind}] ticket=${ticketId} delay=${Math.round(delay / 1000)}s`,
    );
  }

  /** 不传 kind 则取消该工单全部 SLA 任务 */
  async cancel(ticketId: string, kind?: SlaKind) {
    for (const k of kind ? [kind] : KINDS) {
      try {
        const job = await this.queue.getJob(jobIdOf(ticketId, k));
        if (job) await job.remove();
      } catch {
        /* 任务可能已执行完被清理，忽略 */
      }
    }
  }
}
