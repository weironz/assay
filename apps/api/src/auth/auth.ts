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
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 天
    updateAge: 60 * 60 * 24, // 每天滑动续期
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: 'lax',
      httpOnly: true,
    },
  },
});

export type Auth = typeof auth;
