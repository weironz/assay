import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';
import { DRAFT_TTL_HOURS } from './limits';
import type { DeletionDrainResult } from './deletion-queue';
import {
  enqueueObjectDeletions,
  processObjectDeletions,
} from './deletion-queue';

/** 单轮清理条数：草稿清理不是紧急任务，别一次占着太多数据库连接和存储请求。 */
const SWEEP_BATCH = 200;
/** 单轮最多扫几批，避免积压时一轮清理长时间占着资源。 */
const SWEEP_MAX_BATCHES = 10;
/** 草稿扫描间隔。保留期以小时计，每小时扫一次足够。 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** 删除 outbox 的领取间隔：失败对象按退避时间重试，空队列时几乎没有开销。 */
const DELETION_DRAIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 附件对象存储的生命周期兜底。
 *
 * 1. 草稿回收：建单前上传的草稿（ticketId=null）如果一直没关联工单（用户放弃
 *    建单、上传后关页面、提交失败重试），DB 记录和对象都会永久留在存储里。
 *    按 DRAFT_TTL_HOURS 回收，避免对象存储被未完成的上传慢慢撑满。
 * 2. 删除 outbox：工单删除、草稿回收产生的对象删除都先持久化，再由这里重试。
 *    S3 删除失败不会随请求丢失；每次失败都写 error 日志，连续失败会标记为
 *    需要人工处理。
 *
 * 草稿只扫 ticketId 为空的记录：工单内未绑定消息的图片可能还在正文里被引用
 * （例如建单正文的内联图），不能按「没 messageId」删。
 */
@Injectable()
export class AttachmentMaintenanceService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('Attachments');
  private sweepTimer?: NodeJS.Timeout;
  private drainTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  onModuleInit() {
    void this.sweep().catch((error) =>
      this.logger.error('草稿附件清理失败', error),
    );
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error) =>
        this.logger.error('草稿附件清理失败', error),
      );
    }, SWEEP_INTERVAL_MS);
    this.drainTimer = setInterval(() => {
      void this.processDeletions().catch((error) =>
        this.logger.error('附件删除队列处理失败', error),
      );
    }, DELETION_DRAIN_INTERVAL_MS);
    // 与 SlaService 一致：定时器不能拖住进程退出。
    this.sweepTimer.unref();
    this.drainTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
  }

  /**
   * 处理到期的对象删除任务。失败只保留在 outbox 里等待下一轮，不会抛出，
   * 因此请求路径可以「提交后立即尝试删除、失败也不回滚业务」。
   */
  async processDeletions(now = new Date()): Promise<DeletionDrainResult> {
    try {
      return await processObjectDeletions(
        this.prisma,
        this.storage,
        this.logger,
        now,
      );
    } catch (error) {
      this.logger.error('附件删除队列处理失败', error as Error);
      return { deleted: 0, retrying: 0 };
    }
  }

  /**
   * 清理超过保留期的草稿附件，返回本轮实际删除的记录数。
   *
   * 扫描后逐条带 ticketId=null 条件领取：万一草稿恰好在这一刻被建单关联，
   * 删除会命中 0 行，从而避免把已被引用的对象删掉。领取记录与 outbox 入队
   * 在同一个事务里提交：记录删掉但对象 key 没记下来是唯一不可恢复的失败，
   * 这一步必须原子。事务提交后再立即尝试删对象，失败由 outbox 重试。
   */
  async sweep(now = new Date()) {
    const cutoff = new Date(now.getTime() - DRAFT_TTL_HOURS * 3_600_000);
    let removed = 0;
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const drafts = await this.prisma.ticketAttachment.findMany({
        where: { ticketId: null, createdAt: { lt: cutoff } },
        select: { id: true, objectKey: true },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH,
      });
      if (!drafts.length) break;

      const claimed = await this.prisma.$transaction(async (tx) => {
        const objectKeys: string[] = [];
        for (const draft of drafts) {
          const claim = await tx.ticketAttachment.deleteMany({
            where: { id: draft.id, ticketId: null, createdAt: { lt: cutoff } },
          });
          if (claim.count) objectKeys.push(draft.objectKey);
        }
        if (objectKeys.length) {
          await enqueueObjectDeletions(tx, objectKeys, 'DRAFT_EXPIRED', now);
        }
        return objectKeys;
      });

      removed += claimed.length;
      // 正常情况下这一步就把对象删掉；删除失败会持久化在 outbox 里等重试。
      // 不能用 sweep 开始时的 now 去 drain：outbox 行是在事务里刚写入的，
      // 时间不会早于 now，必须用「不早于 now 的当前时间」才能立刻领取。
      const drainAt = new Date(Math.max(now.getTime(), Date.now()));
      await this.processDeletions(drainAt);
      // 这批里没有能删的记录（都是扫描后被关联/删掉的），再查也是同一批。
      if (drafts.length < SWEEP_BATCH || claimed.length === 0) break;
    }
    if (removed) this.logger.log(`已清理 ${removed} 个过期草稿附件记录`);
    return removed;
  }
}
