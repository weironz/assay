import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { constantTimeEqual, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { z } from 'zod';
import { authRedis } from './auth-redis';
import { assertSessionEpochMigration } from './session-epoch';
import { checkStepUpRate, releaseSuccessfulStepUpAttempt, reserveTotpCode } from './step-up-store';
import { connectDirectoryFiles, directoryClient, directoryError, directorySettings, resolveDirectoryIdentity } from './directory-runtime';
// This package exposes .d.mts only; the API still compiles with legacy CommonJS resolution.
const { createOTP } = require('@better-auth/utils/otp') as { createOTP: (secret: string, options: { digits: number; period: number }) => { verify: (code: string) => Promise<boolean> } };

const loginBody = z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(512).refine(p => !p.includes('\0')),
  rememberMe: z.boolean().default(true), code: z.string().regex(/^(?:\d{6}|[A-Za-z0-9]{5}-[A-Za-z0-9]{5})$/).optional() }).strict();
export function directoryPlugin(db: PrismaClient): BetterAuthPlugin {
  return { id: 'assay-directory', endpoints: {
    directoryProvider: createAuthEndpoint('/directory/provider', { method: 'GET' }, async ctx => ctx.json({ enabled: !!directorySettings, name: directorySettings?.name || null })),
    directorySignIn: createAuthEndpoint('/sign-in/directory', { method: 'POST', body: loginBody }, async ctx => {
      const settings = directorySettings, client = directoryClient;
      if (!settings || !client) throw new APIError('NOT_FOUND', { message: 'Directory login is not enabled' });
      const origin = ctx.headers?.get('origin');
      if (!origin || !settings.origins.includes(origin) || ctx.headers?.has('authorization')) throw new APIError('FORBIDDEN', { message: 'Trusted web origin required' });
      const key = 'assay:directory:login:' + createHash('sha256').update(ctx.body.username.toLowerCase()).digest('hex');
      const attempts = Number(await authRedis.eval("local n=redis.call('INCR',KEYS[1]); if redis.call('TTL',KEYS[1])<0 then redis.call('EXPIRE',KEYS[1],900) end; return n", { keys: [key], arguments: [] }));
      if (attempts > 5) throw new APIError('TOO_MANY_REQUESTS', { message: '公司账号验证次数过多，请稍后重试' });
      try {
        await assertSessionEpochMigration(db);
        const profile = await client.authenticate(ctx.body.username, ctx.body.password);
        const user = await resolveDirectoryIdentity(db, profile);
        if (user.twoFactorEnabled) {
          if (!ctx.body.code) {
            await authRedis.decr(key);
            return ctx.json({ twoFactorRequired: true });
          }
          const factor = await db.twoFactor.findUnique({ where: { userId: user.id } });
          await checkStepUpRate(user.id);
          if (!factor?.verified) throw new Error('FACTOR_REJECTED');
          if (/^\d{6}$/.test(ctx.body.code)) {
            if (!await createOTP(await symmetricDecrypt({ key: ctx.context.secretConfig, data: factor.secret }), { digits: 6, period: 30 }).verify(ctx.body.code)) throw new Error('FACTOR_REJECTED');
            await reserveTotpCode(user.id, ctx.body.code);
          } else {
            const codes: string[] = JSON.parse(await symmetricDecrypt({ key: ctx.context.secretConfig, data: factor.backupCodes }));
            const selected = codes.find(code => constantTimeEqual(code, ctx.body.code!));
            if (!selected) throw new Error('FACTOR_REJECTED');
            const replacement = await symmetricEncrypt({ key: ctx.context.secretConfig, data: JSON.stringify(codes.filter(code => code !== selected)) });
            const consumed = await db.twoFactor.updateMany({ where: { id: factor.id, backupCodes: factor.backupCodes }, data: { backupCodes: replacement } });
            if (consumed.count !== 1) throw new Error('FACTOR_REPLAY');
          }
          await releaseSuccessfulStepUpAttempt(user.id);
        }
        Object.assign(ctx.context, {
          assaySignInEpoch: { userId: user.id, epoch: user.sessionEpoch },
          assayDirectorySession: { userId: user.id, providerId: settings.providerId, objectId: profile.id, securityStamp: profile.securityStamp },
        });
        const session = await ctx.context.internalAdapter.createSession(user.id, !ctx.body.rememberMe);
        if (!session) throw new Error('SESSION_FAILED');
        const filesConnected = await connectDirectoryFiles(session, ctx.body.password, origin);
        await setSessionCookie(ctx, { session, user }, !ctx.body.rememberMe);
        await authRedis.decr(key);
        return ctx.json({ ok: true, filesConnected, destination: filesConnected ? '/files' : '/dashboard' });
      } catch (e) { directoryError(e); }
      finally { ctx.body.password = ''; }
    }),
  } };
}
