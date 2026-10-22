import { createClient } from 'redis';

// Shared by Better Auth and step-up tickets; Redis failure must fail closed.
export const authRedis = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379',
});
authRedis.on('error', (e) => console.error('[better-auth redis]', e.message));
authRedis.connect().catch((e) => console.error('[better-auth redis connect]', e));

/**
 * 启动期探活：模块加载时发起的 connect 一旦被拒（Redis 未就绪、地址写错）
 * 客户端不会自行重建连接，进程就此带病运行。启动阶段重试若干次，
 * 仍不通则交给调用方决定告警还是拒绝启动。
 */
export async function waitForAuthRedis(attempts = 10, delayMs = 1000): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (!authRedis.isOpen) await authRedis.connect();
      await authRedis.ping();
      return true;
    } catch (e) {
      console.error(`[better-auth redis ready] 探测失败（第 ${attempt}/${attempts} 次）:`, (e as Error).message);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
