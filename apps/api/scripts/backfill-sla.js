/**
 * 一次性维护脚本：给「SLA 计时重做」之前就存在的在办工单补上时限。
 *
 * 背景：新模型从建单时刻起算，但它只在建单时写入截止时刻。上线前就存在的
 * 工单（尤其是一直没人接手的）两个时限都是空的，等于不在监控范围内——而这
 * 恰恰是这次改动想解决的问题。
 *
 * 口径：**从执行时刻起重新计时**，不是按建单时刻回填。按建单时刻算的话，
 * 存量老单会当场全部判超时，瞬间炸出一批通知并自动升一级优先级；从现在起
 * 算则不会打扰任何人，今后正常监控。
 *
 * 只处理在办状态；终态（已解决/已关闭/已取消）不碰。
 * 挂起中的单只写时限并记下暂停起点，不排任务——它的时钟本来就该是停的。
 *
 * 用法（在 api 容器内）：
 *   node scripts/backfill-sla.js          # 预演，只打印不写库
 *   node scripts/backfill-sla.js --apply  # 真正执行
 */
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');

const OPEN = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'REOPENED'];
/** 与 apps/api/src/tickets/tickets.service.ts 的 FALLBACK_SLA 保持一致 */
const FALLBACK = { responseMin: 60, resolveMin: 1440 };

const APPLY = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  const queue = new Queue('sla', {
    connection: {
      host: process.env.REDIS_HOST || 'redis',
      port: Number(process.env.REDIS_PORT) || 6379,
    },
  });

  const tickets = await prisma.ticket.findMany({
    where: { status: { in: OPEN } },
    include: { type: true },
    orderBy: { createdAt: 'asc' },
  });

  const now = new Date();
  console.log(
    `${APPLY ? '执行' : '预演'}：在办工单 ${tickets.length} 张，计时起点 ${now.toISOString()}\n`,
  );

  for (const tk of tickets) {
    const responseMin = tk.type?.slaResponseMin ?? FALLBACK.responseMin;
    const resolveMin = tk.type?.slaResolveMin ?? FALLBACK.resolveMin;
    const resolveDue = new Date(now.getTime() + resolveMin * 60_000);
    // 已经有人回过就不再设响应时限，那条时限已经达成了
    const responseDue = tk.firstResponseAt
      ? null
      : new Date(now.getTime() + responseMin * 60_000);
    const paused = tk.status === 'PENDING';

    console.log(
      `${tk.ticketNo} [${tk.status}] 类型=${tk.type?.name ?? '(无)'} ` +
        `响应=${responseDue ? responseMin + 'min' : '已响应，跳过'} ` +
        `解决=${resolveMin}min` +
        (paused ? ' （挂起中：只写时限，不排任务）' : ''),
    );

    if (!APPLY) continue;

    await prisma.ticket.update({
      where: { id: tk.id },
      data: {
        slaDueAt: resolveDue,
        firstResponseDueAt: responseDue,
        // 挂起中的单要记下暂停起点，恢复时才能把这段时间补回去
        ...(paused && !tk.holdStartedAt ? { holdStartedAt: now } : {}),
      },
    });

    if (paused) continue; // 时钟停着，不排到期任务

    for (const [kind, due] of [
      ['response', responseDue],
      ['resolve', resolveDue],
    ]) {
      if (!due) continue;
      const jobId = `${tk.id}-${kind}`;
      const old = await queue.getJob(jobId);
      if (old) await old.remove();
      await queue.add(
        'check',
        { ticketId: tk.id, kind },
        {
          delay: Math.max(0, due.getTime() - Date.now()),
          jobId,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
  }

  console.log(
    `\n${APPLY ? '已完成。' : '以上为预演结果，加 --apply 才会写库。'}`,
  );
  await queue.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
