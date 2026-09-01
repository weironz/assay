import { betterAuth, APIError } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import { mailEnabled, mailTemplate, sendMail } from '../mail/mailer';

/**
 * 是否强制邮箱验证后才能登录。
 * 默认：配置了发信服务就开启（否则会把所有人锁在门外）。
 * 可用 REQUIRE_EMAIL_VERIFICATION=true/false 显式覆盖。
 */
const REQUIRE_EMAIL_VERIFICATION =
  process.env.REQUIRE_EMAIL_VERIFICATION !== undefined
    ? process.env.REQUIRE_EMAIL_VERIFICATION === 'true'
    : mailEnabled;

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
    // 开放邮箱自助注册；配了发信服务时要求先验证邮箱才能登录
    disableSignUp: false,
    requireEmailVerification: REQUIRE_EMAIL_VERIFICATION,
    minPasswordLength: 6,
    // 忘记密码：发重置链接
    sendResetPassword: async ({ user, url }) => {
      await sendMail(
        user.email,
        '重置你的密码 · 工单管理系统',
        mailTemplate({
          heading: '重置密码',
          body: '我们收到了你的密码重置请求。点击下方按钮设置新密码，链接 1 小时内有效。若非本人操作，请忽略此邮件。',
          actionText: '设置新密码',
          actionUrl: url,
        }),
      );
    },
  },
  emailVerification: {
    autoSignInAfterVerification: true,
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail(
        user.email,
        '验证你的邮箱 · 工单管理系统',
        mailTemplate({
          heading: '欢迎使用工单管理系统',
          body: `你好 ${user.name || ''}，请点击下方按钮验证邮箱地址，验证后即可登录使用。`,
          actionText: '验证邮箱',
          actionUrl: url,
        }),
      );
    },
  },
  user: {
    // 允许用户自助注销账号（需密码确认；有工单记录的账号禁止删除，见 beforeDelete）
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        const [tickets, messages] = await Promise.all([
          prisma.ticket.count({
            where: {
              OR: [{ requesterId: user.id }, { assigneeId: user.id }],
            },
          }),
          prisma.ticketMessage.count({ where: { authorId: user.id } }),
        ]);
        if (tickets > 0 || messages > 0) {
          throw new APIError('BAD_REQUEST', {
            message:
              '该账号已有工单或回复记录，无法删除。如需停用请联系管理员禁用账号。',
          });
        }
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // 自助注册的新用户默认给「提单人」角色，否则登录后零权限
        after: async (user) => {
          try {
            const role = await prisma.role.findUnique({
              where: { name: 'requester' },
            });
            if (!role) return;
            await prisma.userRole.createMany({
              data: [{ userId: user.id, roleId: role.id }],
              skipDuplicates: true,
            });
          } catch (e) {
            console.error('[auth] 分配默认角色失败:', (e as Error).message);
          }
        },
      },
    },
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
      '/sign-up/email': { window: 3600, max: 5 }, // 注册：每 IP 每小时 5 个账号
      '/request-password-reset': { window: 3600, max: 5 }, // 防邮件轰炸
      '/forget-password': { window: 3600, max: 5 }, // 旧版别名
      '/send-verification-email': { window: 3600, max: 5 },
      '/delete-user': { window: 3600, max: 5 },
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
