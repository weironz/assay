import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { StorageDriver } from '../storage/storage.interface';

/**
 * 对象删除的持久化 outbox。
 *
 * 对象存储的删除不在数据库事务里，先删记录再删对象是唯一安全的顺序；但只把
 * 「删对象」放在请求路径上，一旦 S3 暂时不可用就只能留一条日志，进程重启后
 * 再也找不到这个对象（DB 记录已经没了）。这里把待删 key 和业务删除写进同一
 * 个事务，后台任务按 lease 领取并重试：
 * - 删除成功 → 删掉 outbox 行；
 * - 删除失败 → 记录 attempts / lastError / nextAttemptAt，指数退避重试；
 * - 连续失败超过阈值 → 用 error 级别日志告警，提醒人工处理。
 *
 * 领取用 updateMany 做条件更新，多个实例同时扫描时只有一个能拿到同一行；
 * lease 到期后其他实例可以接手，避免 worker 崩溃导致任务永久卡死。
 */

/** 单轮最多处理多少条，避免积压时长时间占着存储请求。 */
const DELETION_BATCH = 100;
/** 领取后多久内不允许其他 worker 再领，防止重复删除；崩溃后到期自动接手。 */
const DELETION_LEASE_MS = 10 * 60 * 1000;
/** 首次重试等待，之后按 2 的幂退避。 */
const DELETION_RETRY_BASE_MS = 5 * 60 * 1000;
/** 退避上限：每天最多重试一次，避免永久失败的任务无限打存储。 */
const DELETION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
/** 连续失败达到这个次数后在日志里标记为需要人工处理。 */
export const DELETION_ALERT_AFTER = 5;

type DeletionDb = Pick<Prisma.TransactionClient, 'attachmentDeletionTask'>;

export type DeletionDrainResult = {
  deleted: number;
  retrying: number;
};

/**
 * 把待删对象 key 写进 outbox。必须传入事务客户端，和业务记录删除一起提交。
 * 同一个 key 在调用内去重；跨调用重复入队也无害（对象删除是幂等的）。
 */
export async function enqueueObjectDeletions(
  db: DeletionDb,
  objectKeys: readonly string[],
  reason: string,
  nextAttemptAt = new Date(),
): Promise<number> {
  const keys = [...new Set(objectKeys.filter((key) => !!key))];
  if (!keys.length) return 0;
  await db.attachmentDeletionTask.createMany({
    data: keys.map((objectKey) => ({ objectKey, reason, nextAttemptAt })),
  });
  return keys.length;
}

function retryDelayMs(attempts: number) {
  const exponent = Math.min(Math.max(attempts - 1, 0), 8);
  return Math.min(DELETION_RETRY_MAX_MS, DELETION_RETRY_BASE_MS * 2 ** exponent);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 处理到期的删除任务。单条失败只影响该条，不阻断同批其他对象；返回本轮
 * 成功/待重试数量。数据库本身不可用时异常向上抛，由调用方记录。
 */
export async function processObjectDeletions(
  db: DeletionDb,
  storage: Pick<StorageDriver, 'delete'>,
  logger: Pick<Logger, 'error'>,
  now = new Date(),
  batch = DELETION_BATCH,
): Promise<DeletionDrainResult> {
  const pending = await db.attachmentDeletionTask.findMany({
    where: { nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: batch,
    select: { id: true, objectKey: true, attempts: true },
  });

  let deleted = 0;
  let retrying = 0;
  for (const task of pending) {
    // 条件更新即领取：并发 worker 只有一个能把 nextAttemptAt 推到未来。
    const claimed = await db.attachmentDeletionTask.updateMany({
      where: { id: task.id, nextAttemptAt: { lte: now } },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + DELETION_LEASE_MS),
      },
    });
    if (!claimed.count) continue;

    const attempts = task.attempts + 1;
    try {
      await storage.delete(task.objectKey);
    } catch (error) {
      const message = errorMessage(error);
      await db.attachmentDeletionTask.update({
        where: { id: task.id },
        data: {
          lastError: message.slice(0, 2000),
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
        },
      });
      retrying += 1;
      if (attempts >= DELETION_ALERT_AFTER) {
        logger.error(
          `附件对象删除连续失败 ${attempts} 次，需要人工处理（key=${task.objectKey}）：${message}`,
        );
      } else {
        // 第一次失败就用 error 级别记录，方便日志告警规则直接命中；任务本身
        // 仍会按退避时间自动重试。
        logger.error(
          `附件对象删除失败，已安排重试（key=${task.objectKey}，第 ${attempts} 次）：${message}`,
        );
      }
      continue;
    }

    // 成功即出队；如果这里失败，任务会在 lease 到期后重试，S3 删除幂等。
    // 用 deleteMany 而不是 delete：并发 worker 的 lease 恰好到期时，另一个
    // worker 可能已经先出队，这里命中 0 行不应抛异常。
    const removed = await db.attachmentDeletionTask.deleteMany({
      where: { id: task.id },
    });
    if (removed.count) deleted += 1;
  }
  return { deleted, retrying };
}
