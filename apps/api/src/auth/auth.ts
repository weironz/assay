import { betterAuth, APIError } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { twoFactor } from 'better-auth/plugins';
import { constantTimeEqual } from 'better-auth/crypto';
import { PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { mailEnabled, mailTemplate, sendMail } from '../mail/mailer';
import { authRedis } from './auth-redis';
import { requireAuthSecret } from './auth-secret';
import { enforceBetterAuthSensitiveStepUp } from './better-auth-step-up';
import { assertCanLoseActiveAdmin } from './last-admin';
import { assertUserDeletable } from './user-deletion';
import { captureAuthEpoch, readValidatedSession, refreshSessionMarker, stampSessionEpoch, stampTwoFactorChallenge } from './session-epoch';
import { readOidcSettings } from './oidc-config';
import { oidcPlugin } from './oidc';
import { directoryPlugin } from './directory';
import { directorySettings, stampDirectorySession, validatedDirectorySession, verifyDirectoryPassword } from './directory-runtime';
import { checkStepUpRate, releaseSuccessfulStepUpAttempt } from './step-up-store';
import { unifiedLoginPlugin } from './unified-login';
import { publicRegistrationBlocked, registrationEnabled } from './login-policy';

/**
 * 是否强制邮箱验证后才能登录。
 * 默认：配置了发信服务就开启（否则会把所有人锁在门外）。
 * 可用 REQUIRE_EMAIL_VERIFICATION=true/false 显式覆盖。
 */
const REQUIRE_EMAIL_VERIFICATION =
  process.env.REQUIRE_EMAIL_VERIFICATION !== undefined
    ? process.env.REQUIRE_EMAIL_VERIFICATION === 'true'
    : mailEnabled;

// better-auth 使用独立的 PrismaClient（在 Nest DI 之外，模块加载时即需就绪）。
// 由 AuthLifecycleService 在应用关闭时 $disconnect()，避免 SIGTERM 时连接泄漏；
// 与 Nest 的 PrismaService 合并为单一连接池需要把 better-auth 构造挪进工厂，
// 涉及全部依赖方与测试，属独立的后续重构。
export const authPrisma = new PrismaClient();
const prisma = authPrisma;
const oidcSettings = readOidcSettings();
const directory = directoryPlugin(prisma);

// Redis 二级存储：会话数据存 Redis，可即时撤销（删 key 即失效）
export const auth = betterAuth({
  appName: 'Greenstor Assay',
  baseURL: process.env.AUTH_BASE_URL || 'http://localhost:3000',
  basePath: '/api/auth',
  secret: requireAuthSecret(),
  trustedOrigins: (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(
    ',',
  ),
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  plugins: [twoFactor({ issuer: 'Greenstor Assay', allowPasswordless: true }), oidcPlugin(oidcSettings, prisma), directory, unifiedLoginPlugin(prisma, directory.endpoints!.directorySignIn)],
  account: { storeStateStrategy: 'database', accountLinking: { enabled: false } },
  ...(oidcSettings ? { onAPIError: { errorURL: `${oidcSettings.origins[0]}/login?oidc_error=1` } } : {}),
  // These routes are handled directly by Better Auth before Nest's guards.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email' && publicRegistrationBlocked(registrationEnabled(), ctx))
        throw new APIError('FORBIDDEN', { code: 'REGISTRATION_DISABLED', message: '注册未开放，请联系管理员创建账号' });
      await captureAuthEpoch(prisma, ctx);
      if (directorySettings && ctx.path === '/sign-in/email') {
        const email = (ctx.body as any)?.email;
        if (typeof email === 'string' && await prisma.directoryIdentity.findFirst({ where: { user: { email: { equals: email.trim(), mode: 'insensitive' } } } }))
          throw new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
      }
      if (ctx.headers && !['/get-session', '/sign-out'].includes(ctx.path) && !ctx.path.startsWith('/sign-in/')) {
        const current = await auth.api.getSession({ headers: ctx.headers });
        if (current) {
          try {
            const directory = await validatedDirectorySession(prisma, current.session.token, current.user.id);
            if (directory && ['/change-password', '/set-password'].includes(ctx.path)) throw new Error('DIRECTORY_MANAGED_PASSWORD');
          }
          catch { throw new APIError('UNAUTHORIZED', { message: '公司账号会话已失效，请重新登录' }); }
        }
      }
      // Passwordless IdP users still prove fresh AD possession before MFA setup.
      // Local accounts keep Better Auth's normal password checks.
      if (['/two-factor/enable', '/two-factor/disable', '/two-factor/get-totp-uri', '/two-factor/generate-backup-codes'].includes(ctx.path)) {
        const session = ctx.headers && await auth.api.getSession({ headers: ctx.headers });
        if (session) {
          const credential = await prisma.account.findFirst({ where: { userId: session.user.id, providerId: 'credential', password: { not: null } } });
          const directory = directorySettings && await prisma.directoryIdentity.findUnique({ where: { userId: session.user.id } });
          if (directory || !credential) {
            await checkStepUpRate(session.user.id);
            const password = (ctx.body as any)?.password;
            try { await verifyDirectoryPassword(prisma, session.user.id, password); }
            catch { throw new APIError('UNAUTHORIZED', { message: '安全验证失败' }); }
            await releaseSuccessfulStepUpAttempt(session.user.id);
            if (directory && credential?.password) {
              // Better Auth clones this context for each request. A retained, inactive
              // local hash must not force a second password during the AD user's MFA setup.
              const retainedHash = credential.password;
              ctx.context.password = { ...ctx.context.password,
                verify: async input => constantTimeEqual(input.hash, retainedHash) && constantTimeEqual(input.password, password),
              };
            }
          }
        }
      }
      await enforceBetterAuthSensitiveStepUp(ctx.path, ctx.headers, {
        session: () => auth.api.getSession({ headers: ctx.headers! }),
        user: (id) => prisma.user.findUnique({
          where: { id }, select: { status: true, twoFactorEnabled: true, twoFactor: { select: { verified: true } }, roles: { include: { role: true } }, directoryIdentity: true },
        }),
      });
    }),
  },
  emailAndPassword: {
    enabled: true,
    revokeSessionsOnPasswordReset: true,
    // Public signup is controlled in the hook; headerless internal admin provisioning remains available.
    disableSignUp: false,
    requireEmailVerification: REQUIRE_EMAIL_VERIFICATION,
    minPasswordLength: 6,
    // 忘记密码：发重置链接
    sendResetPassword: async ({ user, url }) => {
      if (directorySettings && await prisma.directoryIdentity.findUnique({ where: { userId: user.id } })) return;
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
    // 验证邮箱不自动签发会话，避免已启用 2FA 的账号从邮件链接绕过第二因子。
    autoSignInAfterVerification: false,
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
    // 允许用户自助注销账号（需密码确认；有工单/回复/附件/库存记录的账号禁止删除，见 beforeDelete）
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        try {
          await assertCanLoseActiveAdmin(prisma, user.id);
        } catch (error) {
          if (error instanceof ConflictException) {
            throw new APIError('CONFLICT', { message: '不能删除最后一位在职管理员' });
          }
          throw error;
        }
        // 统一约束检查见 auth/user-deletion.ts：规则与管理员删除入口共用。
        // better-auth 的实际删除不经过我们的事务兜底，漏登记会让用户看到 500
        // 且会话已被销毁，新增外键时务必在 BLOCKING_QUERIES 中登记。
        try {
          await assertUserDeletable(prisma, user.id, '如需停用请联系管理员禁用账号。');
        } catch (error) {
          if (error instanceof ConflictException) {
            throw new APIError('BAD_REQUEST', { message: error.message });
          }
          throw error;
        }
        // Invalidate orphaned Redis sessions before Better Auth deletes the
        // user. A failed later delete may log the user out, but never revive
        // an old session.
        await prisma.user.update({ where: { id: user.id }, data: { sessionEpoch: { increment: 1 } } });
      },
    },
  },
  databaseHooks: {
    account: { create: { before: async (account) => {
      if (account.providerId === 'credential' && await prisma.directoryIdentity.findUnique({ where: { userId: account.userId } }))
        throw new APIError('FORBIDDEN', { message: '公司账号密码由 AD 管理，请联系管理员' });
    } } },
    session: {
      create: {
        before: async (session, ctx) => {
          await stampSessionEpoch(prisma, ctx, session);
          await stampDirectorySession(ctx, session, prisma);
        },
      },
    },
    verification: {
      create: {
        before: async (verification, ctx) => {
          await stampTwoFactorChallenge(ctx, verification);
        },
      },
    },
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
    get: async (key) => readValidatedSession(prisma, key),
    getAndDelete: async (key) => authRedis.getDel(key),
    set: async (key, value, ttl) => {
      await refreshSessionMarker(key, value, ttl);
      if (ttl) await authRedis.set(key, value, { EX: ttl });
      else await authRedis.set(key, value);
    },
    delete: async (key) => {
      await authRedis.del(key);
    },
    // 原子自增（供限流计数用）：首次计数时设过期为窗口时长
    increment: async (key: string, ttl?: number) => {
      const count = await authRedis.incr(key);
      if (count === 1 && ttl) await authRedis.expire(key, ttl);
      return count;
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 天
    updateAge: 60 * 60 * 24, // 每天滑动续期
    cookieCache: { enabled: false }, // every request must check the durable epoch
  },
  // 限流：防登录爆破。计数走 Redis；x-real-ip 由前端 nginx 用真实来源地址
  // 覆盖转发（见 apps/web/nginx.conf 的 realip 配置），客户端伪造的头到不了这里
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: 'secondary-storage',
    customRules: {
      '/sign-in/email': { window: 60, max: 5 }, // 登录：每 IP 每分钟最多 5 次
      '/sign-in/unified': { window: 60, max: 5 },
      '/sign-in/local-admin': { window: 60, max: 5 },
      '/sign-in/directory': { window: 60, max: 5 },
      '/sign-in/oidc': { window: 60, max: 10 },
      '/oidc/link': { window: 60, max: 5 },
      '/sign-up/email': { window: 3600, max: 5 }, // 注册：每 IP 每小时 5 个账号
      '/request-password-reset': { window: 3600, max: 5 }, // 防邮件轰炸
      '/forget-password': { window: 3600, max: 5 }, // 旧版别名
      '/send-verification-email': { window: 3600, max: 5 },
      '/delete-user': { window: 3600, max: 5 },
      '/two-factor/verify-totp': { window: 60, max: 10 },
      '/two-factor/verify-backup-code': { window: 60, max: 10 },
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
