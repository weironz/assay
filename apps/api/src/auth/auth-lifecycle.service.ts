import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { authPrisma } from './auth';
import { authRedis, waitForAuthRedis } from './auth-redis';
import { getConfig } from '../config';

/**
 * better-auth 的两个游离客户端（auth.ts 的 PrismaClient、auth-redis.ts 的
 * RedisClient）不经过 Nest DI，由本服务接管其启动探活与优雅关闭；
 * Nest 自己的 PrismaService 仍走自身的 OnModuleDestroy。
 */
@Injectable()
export class AuthLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AuthLifecycle');

  async onApplicationBootstrap() {
    const ready = await waitForAuthRedis();
    if (ready) return;
    const message = 'Redis 启动探测失败：better-auth 的会话、限流与安全验证计数不可用';
    if (getConfig().isProduction) throw new Error(message);
    this.logger.error(`${message}（非生产仅告警，Redis 恢复后功能即恢复）`);
  }

  async onApplicationShutdown() {
    // SIGTERM 优雅停机由 main.ts 的 enableShutdownHooks 触发。
    await Promise.allSettled([
      authPrisma.$disconnect(),
      authRedis.isOpen ? authRedis.quit() : Promise.resolve(),
    ]);
  }
}
