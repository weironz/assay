import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';

// better-auth 使用独立的 PrismaClient（在 Nest DI 之外，模块加载时即需就绪）
const prisma = new PrismaClient();

// Redis 二级存储：会话数据存 Redis，可即时撤销（删 key 即失效）
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379',
});
redis.on('error', (e) => console.error('[better-auth redis]', e.message));
redis.connect().catch((e) => console.error('[better-auth redis connect]', e));

export const auth = betterAuth({
  baseURL: process.env.AUTH_BASE_URL || 'http://localhost:3000',
  basePath: '/api/auth',
  secret: process.env.AUTH_SECRET || 'dev_secret_change_me',
  trustedOrigins: (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(
    ',',
  ),
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    // 内部系统：不开放前台自助注册（账号由管理员创建）
    disableSignUp: false,
  },
  secondaryStorage: {
    get: async (key) => (await redis.get(key)) ?? null,
    set: async (key, value, ttl) => {
      if (ttl) await redis.set(key, value, { EX: ttl });
      else await redis.set(key, value);
    },
    delete: async (key) => {
      await redis.del(key);
    },
    // 原子自增（供限流计数用）：首次计数时设过期为窗口时长
    increment: async (key: string, ttl?: number) => {
      const count = await redis.incr(key);
      if (count === 1 && ttl) await redis.expire(key, ttl);
      return count;
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 天
    updateAge: 60 * 60 * 24, // 每天滑动续期
  },
  // 限流：防登录爆破。计数走 Redis；真实 IP 取 nginx 设置的 x-real-ip
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: 'secondary-storage',
    customRules: {
      '/sign-in/email': { window: 60, max: 5 }, // 登录：每 IP 每分钟最多 5 次
      '/forget-password': { window: 60, max: 3 },
    },
  },
  advanced: {
    ipAddress: {
      ipAddressHeaders: ['x-real-ip'],
    },
    defaultCookieAttributes: {
      sameSite: 'lax',
      httpOnly: true,
    },
  },
});

export type Auth = typeof auth;
