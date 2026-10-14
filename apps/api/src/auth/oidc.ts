import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx, sessionMiddleware } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import { generateState, parseState } from 'better-auth/oauth2';
import { z } from 'zod';
import { OidcClient } from './oidc-client';
import { oidcDestination, type OidcSettings } from './oidc-config';
import { resolveOidcIdentity, type OidcLink } from './oidc-identity';
import { assertSessionEpoch } from './session-epoch';
import { consumeStepUp } from './step-up-store';
import { authRedis } from './auth-redis';

export function oidcPlugin(settings: OidcSettings | null, db: PrismaClient): BetterAuthPlugin {
  const client = settings && new OidcClient(settings);
  const body = z.object({ callbackURL: z.url() });
  const enabled = () => {
    if (!settings || !client) throw new APIError('NOT_FOUND', { message: 'SSO is not enabled' });
    return settings;
  };
  const start = async (ctx: Parameters<typeof generateState>[0], link = false) => {
    const config = enabled();
    const origin = ctx.headers?.get('origin');
    if (!origin || !config.origins.includes(origin)) throw new APIError('FORBIDDEN', { message: 'Trusted web origin required' });
    let destinations;
    try { destinations = oidcDestination(config, ctx.body.callbackURL, link); }
    catch { throw new APIError('BAD_REQUEST', { message: 'Invalid SSO destination' }); }
    let linking: OidcLink | undefined;
    if (link) {
      const session = ctx.context.session;
      if (!session || ctx.headers?.has('authorization')) throw new APIError('UNAUTHORIZED');
      await assertSessionEpoch(db, session.session.token, session.user.id);
      const user = await db.user.findUnique({ where: { id: session.user.id } });
      if (!user || user.status !== 'ACTIVE' || !user.emailVerified) throw new APIError('FORBIDDEN', { message: 'Verified local account required' });
      try { await consumeStepUp(ctx.headers?.get('x-step-up-token'), user.id, session.session.token, 'account'); }
      catch { throw new APIError('FORBIDDEN', { message: 'Fresh account verification required' }); }
      linking = { userId: user.id, epoch: user.sessionEpoch, sessionHash: createHash('sha256').update(session.session.token).digest('hex') };
    }
    const nonce = randomBytes(32).toString('base64url');
    const state = await generateState(ctx, undefined, { oidcNonce: nonce, oidcProvider: config.providerId, oidcLink: linking, oidcDestinations: destinations });
    try {
      return ctx.json({ url: await client!.authorizationURL(state.state, state.codeVerifier, nonce) });
    } catch { throw new APIError('SERVICE_UNAVAILABLE', { message: 'SSO is temporarily unavailable' }); }
  };
  return {
    id: 'assay-oidc',
    endpoints: {
      oidcProvider: createAuthEndpoint('/oidc/provider', { method: 'GET' }, async ctx => ctx.json({
        enabled: Boolean(settings), name: settings?.name || null,
      })),
      oidcSignIn: createAuthEndpoint('/sign-in/oidc', { method: 'POST', body }, ctx => start(ctx)),
      oidcLink: createAuthEndpoint('/oidc/link', { method: 'POST', body, use: [sessionMiddleware] }, ctx => start(ctx, true)),
      oidcAccount: createAuthEndpoint('/oidc/account', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
        const config = enabled();
        const id = ctx.context.session.user.id;
        const user = await db.user.findUnique({ where: { id }, include: { accounts: true } });
        return ctx.json({
          linked: Boolean(user?.accounts.some(account => account.providerId === config.providerId)),
          canLink: Boolean(user?.emailVerified && user.status === 'ACTIVE' && user.accounts.some(account => account.providerId === 'credential' && account.password)),
        });
      }),
      oidcCallback: createAuthEndpoint('/oidc/callback', {
        method: 'GET', query: z.object({ state: z.string().optional(), code: z.string().optional(), error: z.string().optional(), iss: z.string().optional() }),
      }, async ctx => {
        const config = enabled();
        let state;
        try { state = await parseState(ctx); } // Cookie-bound, expiring, server-stored OAuth transaction.
        catch { throw ctx.redirect(`${config.origins[0]}/login?oidc_error=1`); }
        let target = `${config.origins[0]}/login?oidc_error=1`;
        let redirect: string;
        let phase = 'transaction';
        try {
          const destinations = state.oidcDestinations as { success: string; error: string; mfa: string };
          if (state.oidcProvider !== config.providerId || typeof state.oidcNonce !== 'string' || !destinations) throw new Error('OIDC_INVALID_TRANSACTION');
          target = destinations.error;
          // Atomic consumption closes concurrent callback replay, before any token exchange or mutation.
          const consumed = await authRedis.set(`assay:oidc:used:${ctx.query!.state}`, '1', { EX: 600, NX: true });
          if (consumed !== 'OK') throw new Error('OIDC_TRANSACTION_REPLAY');
          const url = new URL(config.callbackURL);
          for (const [key, value] of Object.entries(ctx.query!)) if (value !== undefined) url.searchParams.set(key, value);
          phase = 'token';
          const profile = await client!.profile(url, ctx.query!.state!, state.codeVerifier, state.oidcNonce);
          const link = state.oidcLink as OidcLink | undefined;
          if (link) {
            const session = await getSessionFromCtx(ctx);
            if (!session || session.user.id !== link.userId || createHash('sha256').update(session.session.token).digest('hex') !== link.sessionHash) throw new Error('OIDC_LINK_SESSION_EXPIRED');
            await assertSessionEpoch(db, session.session.token, link.userId);
          }
          phase = 'identity';
          const user = await resolveOidcIdentity(db, config, profile, link);
          if (link) {
            redirect = destinations.success;
          } else {
            // Stamp only after the IdP identity is fully verified, preserving durable local revocation.
            Object.assign(ctx.context, { assaySignInEpoch: { userId: user.id, epoch: user.sessionEpoch } });
            phase = 'session';
            if (user.twoFactorEnabled) {
              deleteSessionCookie(ctx, true);
              const identifier = `2fa-${randomBytes(20).toString('hex')}`;
              const expiresAt = new Date(Date.now() + 600_000);
              await ctx.context.internalAdapter.createVerificationValue({ identifier, value: user.id, expiresAt });
              await ctx.context.internalAdapter.createVerificationValue({ identifier: `2fa-attempts-${identifier}`, value: '0', expiresAt });
              const cookie = ctx.context.createAuthCookie('two_factor', { maxAge: 600 });
              await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
              redirect = destinations.mfa;
            } else {
              const session = await ctx.context.internalAdapter.createSession(user.id);
              if (!session) throw new Error('OIDC_SESSION_FAILED');
              await setSessionCookie(ctx, { session, user });
              redirect = destinations.success;
            }
          }
        } catch {
          // No tokens, provider descriptions, user profiles or secrets in logs/redirects.
          ctx.context.logger.warn(`OIDC callback rejected (${phase})`);
          redirect = target;
        }
        throw ctx.redirect(redirect);
      }),
    },
  };
}
