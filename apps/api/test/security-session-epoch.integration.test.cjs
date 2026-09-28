const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');

const isolatedUrl = process.env.SESSION_EPOCH_TEST_DATABASE_URL;
if (!isolatedUrl) {
  test('session epoch integration requires an isolated PostgreSQL URL', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = isolatedUrl;
  process.env.AUTH_BASE_URL = 'http://localhost:3000';
  process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
  process.env.AUTH_SECRET = 'assay-test-only-secret-with-adequate-entropy-0928';
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const { authRedis } = require('../dist/auth/auth-redis');
  const { auth } = require('../dist/auth/auth');
  const { UsersService } = require('../dist/users/users.service');
  const { AuthService } = require('../dist/auth/auth.service');
  const { SessionGuard } = require('../dist/auth/session.guard');
  const { issueStepUp } = require('../dist/auth/step-up-store');
  const { assertSessionEpochMigration } = require('../dist/auth/session-epoch');

  test.after(async () => { await prisma.$disconnect(); if (authRedis.isOpen) await authRedis.quit(); });

  let requestId = 1;
  const post = (path, body, cookie = '', extra = {}) => auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', 'x-real-ip': `127.0.1.${requestId++}`, ...(cookie ? { cookie } : {}), ...extra },
    body: JSON.stringify(body),
  }));
  const get = (path, cookie) => auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
    method: 'GET', headers: { origin: 'http://localhost:5173', cookie },
  }));
  const cookies = (response) => {
    const values = new Map();
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0];
      values.set(pair.split('=', 1)[0], pair);
    }
    return [...values.values()].join('; ');
  };
  const totpCode = (uri) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const secret = new URL(uri).searchParams.get('secret').toUpperCase();
    let bits = 0, count = 0;
    const bytes = [];
    for (const letter of secret) {
      bits = (bits << 5) | alphabet.indexOf(letter);
      count += 5;
      if (count >= 8) { count -= 8; bytes.push((bits >>> count) & 255); }
    }
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
    const offset = digest.at(-1) & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  };
  const sessionFrom = async (cookie) => {
    const response = await get('/get-session', cookie);
    assert.equal(response.status, 200);
    return response.json();
  };
  const assertRevoked = async (cookie) => {
    const response = await get('/get-session', cookie);
    if (response.status === 401) return;
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
  };
  const signup = async (label) => {
    const email = `epoch-${label}-${randomUUID()}@example.test`;
    const response = await post('/sign-up/email', { email, password: 'old-password-123', name: label });
    assert.equal(response.status, 200, await response.text());
    const cookie = cookies(response);
    const session = await sessionFrom(cookie);
    assert.ok(session?.session?.token);
    return { email, userId: session.user.id, cookie, token: session.session.token };
  };

  test('five security triggers are active and repeated readiness checks are idempotent', async () => {
    await assertSessionEpochMigration(prisma);
    const anotherClient = new PrismaClient();
    try { await assertSessionEpochMigration(anotherClient); }
    finally { await anotherClient.$disconnect(); }
    const rows = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::integer AS count FROM pg_trigger
      WHERE (tgname LIKE 'assay_last_admin_%' OR tgname = 'assay_credential_session_epoch')
        AND tgenabled IN ('O', 'A')
    `);
    assert.equal(rows[0].count, 5);
  });

  test('real Better Auth routes reject orphaned sessions after reset, admin reset, disable and delete', async () => {
    assert.equal(await authRedis.ping(), 'PONG');
    const user = await signup('reset');
    assert.equal((await prisma.user.findUnique({ where: { id: user.userId } })).sessionEpoch, 1, 'credential INSERT trigger installed');

    const signIn = await post('/sign-in/email', { email: user.email, password: 'old-password-123' });
    assert.equal(signIn.status, 200, await signIn.text());
    const oldCookie = cookies(signIn);
    const oldSession = await sessionFrom(oldCookie);
    const oldToken = oldSession.session.token;
    assert.ok(await authRedis.get(oldToken));
    await authRedis.del(`active-sessions-${user.userId}`); // reproduce Better Auth's missing-index race
    const before = (await prisma.user.findUnique({ where: { id: user.userId } })).sessionEpoch;
    const badReset = await post('/reset-password', { token: 'invalid', newPassword: 'new-password-123' });
    assert.equal(badReset.status, 400);
    assert.equal((await prisma.user.findUnique({ where: { id: user.userId } })).sessionEpoch, before);
    assert.ok(await sessionFrom(oldCookie), 'failed reset leaves session valid');

    const resetToken = randomUUID();
    await (await auth.$context).internalAdapter.createVerificationValue({
      identifier: `reset-password:${resetToken}`, value: user.userId, expiresAt: new Date(Date.now() + 60_000),
    });
    const tooShort = await post('/reset-password', { token: resetToken, newPassword: 'x' });
    assert.equal(tooShort.status, 400);
    assert.equal((await prisma.user.findUnique({ where: { id: user.userId } })).sessionEpoch, before);
    assert.ok(await sessionFrom(oldCookie), 'failed reset with a valid token does not revoke');
    const reset = await post('/reset-password', { token: resetToken, newPassword: 'new-password-123' });
    assert.equal(reset.status, 200, await reset.text());
    assert.equal((await prisma.user.findUnique({ where: { id: user.userId } })).sessionEpoch, before + 1);
    assert.ok(await authRedis.get(oldToken), 'orphaned token survived index-based deletion');
    assert.equal(await sessionFrom(oldCookie), null, 'direct Better Auth get-session checks epoch');
    const direct = await post('/two-factor/get-totp-uri', {}, oldCookie);
    assert.equal(direct.status, 401, 'direct Better Auth route rejects orphan');
    const service = new AuthService(prisma, { findActiveBySecret: async () => null });
    const req = { headers: { cookie: oldCookie }, path: '/api/me' };
    assert.equal(await service.getUserFromRequest(req), null, 'app session path checks epoch');
    const guard = new SessionGuard({ getAllAndOverride: () => false }, service);
    const execution = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null };
    await assert.rejects(guard.canActivate(execution), { status: 401 });
    assert.equal((await post('/sign-in/email', { email: user.email, password: 'old-password-123' })).status, 401);

    const newLogin = await post('/sign-in/email', { email: user.email, password: 'new-password-123' });
    assert.equal(newLogin.status, 200, await newLogin.text());
    const newCookie = cookies(newLogin);
    const newSession = await sessionFrom(newCookie);
    await authRedis.del(`active-sessions-${user.userId}`);
    const adminReset = await new UsersService(prisma).resetPassword(user.userId, 'admin-password-123');
    assert.deepEqual(adminReset, { ok: true });
    assert.ok(await authRedis.get(newSession.session.token));
    assert.equal(await sessionFrom(newCookie), null);

    const disabled = await signup('disabled');
    await authRedis.del(`active-sessions-${disabled.userId}`);
    await new UsersService(prisma).update(disabled.userId, { status: 'DISABLED' });
    assert.ok(await authRedis.get(disabled.token));
    await assertRevoked(disabled.cookie);
    assert.equal((await post('/sign-in/email', { email: disabled.email, password: 'old-password-123' })).status, 401);
    await prisma.user.update({ where: { id: disabled.userId }, data: { status: 'ACTIVE' } });
    await assertRevoked(disabled.cookie);

    const deleted = await signup('deleted');
    await authRedis.del(`active-sessions-${deleted.userId}`);
    const ticket = await issueStepUp(deleted.userId, deleted.token, 'account');
    const deletion = await post('/delete-user', {}, deleted.cookie, { 'x-step-up-token': ticket });
    assert.equal(deletion.status, 200, await deletion.text());
    assert.equal(await prisma.user.findUnique({ where: { id: deleted.userId } }), null);
    assert.ok(await authRedis.get(deleted.token));
    await assertRevoked(deleted.cookie);
  });

  test('credential trigger rollback leaves epoch unchanged', async () => {
    const user = await signup('rollback');
    const before = (await prisma.user.findUnique({ where: { id: user.userId } })).sessionEpoch;
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.account.updateMany({ where: { userId: user.userId, providerId: 'credential' }, data: { password: 'temporary-hash' } });
      throw Error('rollback');
    }), /rollback/);
    assert.equal((await prisma.user.findUnique({ where: { id: user.userId } })).sessionEpoch, before);
    assert.ok(await sessionFrom(user.cookie));
  });

  test('TOTP enrollment and pending challenge bind to the pre-reset epoch', async () => {
    const user = await signup('totp');
    const enable = await post('/two-factor/enable', { password: 'old-password-123' }, user.cookie);
    assert.equal(enable.status, 200, enable.status === 200 ? '' : await enable.text());
    const { totpURI } = await enable.json();
    const verified = await post('/two-factor/verify-totp', { code: totpCode(totpURI) }, user.cookie);
    assert.equal(verified.status, 200, await verified.text());
    assert.equal((await prisma.user.findUnique({ where: { id: user.userId } })).twoFactorEnabled, true);
    const verifiedCookie = cookies(verified);
    assert.ok((await sessionFrom(verifiedCookie))?.session?.token);
    const authenticatedHeaders = new Headers({ cookie: verifiedCookie, origin: 'http://localhost:5173' });
    assert.equal((await auth.api.verifyPassword({ headers: authenticatedHeaders, body: { password: 'old-password-123' } })).status, true);
    const currentSessionTotp = await auth.api.verifyTOTP({ headers: authenticatedHeaders, body: { code: totpCode(totpURI), trustDevice: false } });
    assert.ok(currentSessionTotp.token, 'Better Auth 1.6.23 accepts TOTP verification on a normal authenticated session');

    const first = await post('/sign-in/email', { email: user.email, password: 'old-password-123' });
    assert.equal(first.status, 200, first.status === 200 ? '' : await first.text());
    assert.equal((await first.json()).twoFactorRedirect, true);
    const pendingCookie = cookies(first);
    const completion = await post('/two-factor/verify-totp', { code: totpCode(totpURI) }, pendingCookie);
    assert.equal(completion.status, 200, await completion.text());
    assert.ok((await sessionFrom(cookies(completion)))?.session?.token);

    const again = await post('/sign-in/email', { email: user.email, password: 'old-password-123' });
    assert.equal(again.status, 200, await again.text());
    const staleChallenge = cookies(again);
    const resetToken = randomUUID();
    await (await auth.$context).internalAdapter.createVerificationValue({
      identifier: `reset-password:${resetToken}`, value: user.userId, expiresAt: new Date(Date.now() + 60_000),
    });
    const reset = await post('/reset-password', { token: resetToken, newPassword: 'new-password-123' });
    assert.equal(reset.status, 200, await reset.text());
    const staleCompletion = await post('/two-factor/verify-totp', { code: totpCode(totpURI) }, staleChallenge);
    assert.equal(staleCompletion.status, 401);
  });
}
