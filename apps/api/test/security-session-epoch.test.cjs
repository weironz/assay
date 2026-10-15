const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const entries = new Map();
const expirations = new Map();
let redisFailure = false;
const redis = {
  get: async (key) => { if (redisFailure) throw Error('Redis unavailable'); return entries.get(key) ?? null; },
  set: async (key, value) => { if (redisFailure) throw Error('Redis unavailable'); entries.set(key, value); return 'OK'; },
  expire: async (key, ttl) => { if (!entries.has(key)) return false; expirations.set(key, ttl); return true; },
};
const redisPath = require.resolve('../dist/auth/auth-redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { authRedis: redis } };
const epoch = require('../dist/auth/session-epoch');
const marker = (token) => `assay:session-epoch:${createHash('sha256').update(token).digest('hex')}`;
const ready = { $queryRawUnsafe: async () => [{ ready: true }] };
const { registerFileSessionRenewal, webSessionFingerprint } = require('../dist/auth/web-session-scope');

test('business session refresh can renew only an existing file connection using the bounded owner scope', async () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'unit-scope-secret';
  const enabled = [process.env.SAMBA_ENABLED, process.env.FILES_ENABLED]; process.env.SAMBA_ENABLED = 'true'; process.env.FILES_ENABLED = 'true';
  const seen = []; registerFileSessionRenewal(async scope => { seen.push(scope); });
  try {
    const token = 'business-only-sliding-session', expiresAt = new Date(Date.now() + 10 * 86400_000);
    await epoch.refreshSessionMarker(token, JSON.stringify({ session: { token, userId: 'u', expiresAt } }), 604800);
    assert.equal(seen.length, 1); assert.equal(seen[0].fingerprint, webSessionFingerprint(token)); assert.equal(seen[0].userId, 'u');
    assert(seen[0].expiresAt <= Date.now() + 604800_000); assert(!JSON.stringify(seen).includes(token));
    await epoch.refreshSessionMarker('other-token', JSON.stringify({ session: { token, userId: 'u', expiresAt } }), 100);
    assert.equal(seen.length, 1);
  } finally { registerFileSessionRenewal(); if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; for (const [i, name] of ['SAMBA_ENABLED', 'FILES_ENABLED'].entries()) { if (enabled[i] === undefined) delete process.env[name]; else process.env[name] = enabled[i]; } }
});

test('disabled or unconfigured optional files never add a dependency to ordinary Web session refresh', async () => {
  const names = ['AUTH_SECRET', 'SAMBA_ENABLED', 'FILES_ENABLED'], previous = names.map(name => process.env[name]);
  let calls = 0; registerFileSessionRenewal(async () => { calls++; });
  try {
    const token = 'local-only-session', value = JSON.stringify({ session: { token, userId: 'u', expiresAt: new Date(Date.now() + 60000) } });
    for (const name of names) delete process.env[name];
    await epoch.refreshSessionMarker(token, value, 60);
    process.env.AUTH_SECRET = 'unit-scope-secret'; process.env.SAMBA_ENABLED = 'true';
    await epoch.refreshSessionMarker(token, value, 60);
    process.env.FILES_ENABLED = 'true'; delete process.env.AUTH_SECRET;
    await epoch.refreshSessionMarker(token, value, 60);
    assert.equal(calls, 0);
  } finally { registerFileSessionRenewal(); for (const [i, name] of names.entries()) { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; } }
});

test('sliding Web expiry retains existing directory authentication without recreating a revoked stamp', async () => {
  const token = 'sliding-directory-token';
  const directoryKey = `assay:directory:session:${createHash('sha256').update(token).digest('hex')}`;
  entries.set(marker(token), '2'); entries.set(directoryKey, 'unchanged-security-stamp');
  const value = JSON.stringify({ session: { token, userId: 'u' } });
  await epoch.refreshSessionMarker(token, value, 604800);
  assert.equal(expirations.get(marker(token)), 604800); assert.equal(expirations.get(directoryKey), 604800);
  assert.equal(entries.get(directoryKey), 'unchanged-security-stamp');
  entries.delete(directoryKey); expirations.delete(directoryKey);
  await epoch.refreshSessionMarker(token, value, 604800);
  assert.equal(entries.has(directoryKey), false); assert.equal(expirations.has(directoryKey), false);
  await epoch.refreshSessionMarker('different-token', value, 100);
  assert.equal(expirations.get(marker(token)), 604800);
});

test('orphaned legacy token missing from session index dies on epoch bump', async () => {
  const state = { sessionEpoch: 0, status: 'ACTIVE' };
  const db = { ...ready, user: { findUnique: async () => state } };
  const token = 'orphaned-token';
  entries.set(token, JSON.stringify({ session: { token, userId: 'u' }, user: { id: 'u' } }));
  assert.equal(await epoch.readValidatedSession(db, token), entries.get(token));
  state.sessionEpoch++;
  assert.equal(await epoch.readValidatedSession(db, token), null);
  assert.equal(entries.has(token), true, 'Better Auth index deletion did not remove the token');
});

test('login verified before password reset cannot stamp a post-reset session', async () => {
  const state = { sessionEpoch: 0, status: 'ACTIVE' };
  const db = { ...ready, user: {
    findUnique: async () => ({ id: 'u', ...state }),
  } };
  const ctx = { path: '/sign-in/email', body: { email: 'USER@example.test' }, context: {} };
  await epoch.captureAuthEpoch(db, ctx);
  assert.deepEqual(ctx.context.assaySignInEpoch, { userId: 'u', epoch: 0 });
  state.sessionEpoch = 1; // password row and epoch committed together by PostgreSQL trigger
  await assert.rejects(epoch.stampSessionEpoch(db, ctx, {
    token: 'late-login', userId: 'u', expiresAt: new Date(Date.now() + 60_000),
  }), { status: 'UNAUTHORIZED' });
  assert.equal(entries.has(marker('late-login')), false);
});

test('2FA challenge from before reset cannot complete after epoch bump', async () => {
  const state = { sessionEpoch: 0, status: 'ACTIVE' };
  const db = { ...ready, user: { findUnique: async () => state } };
  const first = { context: { assaySignInEpoch: { userId: 'u', epoch: 0 } } };
  await epoch.stampTwoFactorChallenge(first, { identifier: '2fa-challenge', value: 'u', expiresAt: new Date(Date.now() + 60_000) });
  state.sessionEpoch++;
  const second = {
    path: '/two-factor/verify-totp',
    context: { secret: 'secret', createAuthCookie: () => ({ name: 'two_factor' }), session: null },
    getSignedCookie: async () => '2fa-challenge',
  };
  await assert.rejects(epoch.stampSessionEpoch(db, second, {
    token: 'post-2fa', userId: 'u', expiresAt: new Date(Date.now() + 60_000),
  }), { status: 'UNAUTHORIZED' });
});

test('inactive user and unavailable DB or Redis never validate a session', async () => {
  const token = 'inactive-token';
  entries.set(token, JSON.stringify({ session: { token, userId: 'u' }, user: { id: 'u' } }));
  const disabled = { ...ready, user: { findUnique: async () => ({ sessionEpoch: 0, status: 'DISABLED' }) } };
  await assert.rejects(epoch.readValidatedSession(disabled, token), { status: 'UNAUTHORIZED' });
  const dbDown = { ...ready, user: { findUnique: async () => { throw Error('DB unavailable'); } } };
  await assert.rejects(epoch.readValidatedSession(dbDown, token), /DB unavailable/);
  redisFailure = true;
  try { await assert.rejects(epoch.readValidatedSession({ ...ready, user: { findUnique: async () => ({ sessionEpoch: 0, status: 'ACTIVE' }) } }, token), /Redis unavailable/); }
  finally { redisFailure = false; }
});

test('missing credential trigger refuses authentication and reset', async () => {
  const token = 'missing-trigger';
  entries.set(token, JSON.stringify({ session: { token, userId: 'u' }, user: { id: 'u' } }));
  const db = { $queryRawUnsafe: async () => [{ ready: false }], user: { findUnique: async () => ({ sessionEpoch: 0, status: 'ACTIVE' }) } };
  await assert.rejects(epoch.readValidatedSession(db, token), /SESSION_EPOCH_MIGRATION_REQUIRED/);
  await assert.rejects(epoch.captureAuthEpoch(db, { path: '/reset-password', context: {} }), /SESSION_EPOCH_MIGRATION_REQUIRED/);
});
