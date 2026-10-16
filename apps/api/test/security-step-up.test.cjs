const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

process.env.AUTH_BASE_URL ||= 'http://localhost:3000';
require('reflect-metadata');

// Isolate the security tests from the deployment's Redis while preserving
// SET NX/EX and GETDEL behavior used by the one-use tickets.
const entries = new Map();
const read = (key) => {
  const item = entries.get(key);
  if (item && item.expiresAt <= Date.now()) { entries.delete(key); return null; }
  return item || null;
};
const authRedis = {
  isOpen: true,
  async ping() { return 'PONG'; },
  async quit() {},
  async get(key) { return read(key)?.value ?? null; },
  async getDel(key) { const item = read(key); entries.delete(key); return item?.value ?? null; },
  async set(key, value, options = {}) {
    if (options.NX && read(key)) return null;
    entries.set(key, { value, expiresAt: options.EX ? Date.now() + options.EX * 1000 : Infinity });
    return 'OK';
  },
  async incr(key) {
    const item = read(key);
    const value = String(Number(item?.value ?? 0) + 1);
    entries.set(key, { value, expiresAt: item?.expiresAt ?? Infinity });
    return Number(value);
  },
  async eval(_script, { keys, arguments: args }) {
    const [key] = keys;
    const item = read(key);
    const count = Number(item?.value ?? 0) + 1;
    entries.set(key, { value: String(count), expiresAt: Number.isFinite(item?.expiresAt) ? item.expiresAt : Date.now() + Number(args[0]) * 1000 });
    return count;
  },
  async expire(key, seconds) { const item = read(key); if (item) item.expiresAt = Date.now() + seconds * 1000; return !!item; },
  async del(key) { return Number(entries.delete(key)); },
};
const redisModule = require.resolve('../dist/auth/auth-redis');
require.cache[redisModule] = { id: redisModule, filename: redisModule, loaded: true, exports: { authRedis } };
const { auth } = require('../dist/auth/auth');
const store = require('../dist/auth/step-up-store');
const { enforceBetterAuthSensitiveStepUp } = require('../dist/auth/better-auth-step-up');
const { UsersController } = require('../dist/users/users.controller');
const { ApiTokensController } = require('../dist/api-tokens/api-tokens.controller');
const { SessionGuard } = require('../dist/auth/session.guard');
const { StepUpService } = require('../dist/auth/step-up.service');

test('Better Auth email password reset revokes existing sessions', async () => {
  const context = await auth.$context;
  assert.equal(context.options.emailAndPassword.revokeSessionsOnPasswordReset, true);
});

test('one-use ticket is bound to user, session and purpose; expiry fails closed', async () => {
  await authRedis.ping();
  const id = `test-${Date.now()}`;
  const ticket = await store.issueStepUp(id, 'session-A', 'roles');
  await assert.rejects(store.consumeStepUp(ticket, id, 'session-B', 'roles'));
  await assert.rejects(store.consumeStepUp(ticket, id, 'session-A', 'roles'));

  const wrongPurpose = await store.issueStepUp(id, 'session-A', 'api-tokens');
  await assert.rejects(store.consumeStepUp(wrongPurpose, id, 'session-A', 'roles'));
  const wrongUser = await store.issueStepUp(id, 'session-A', 'roles');
  await assert.rejects(store.consumeStepUp(wrongUser, 'other', 'session-A', 'roles'));
  const valid = await store.issueStepUp(id, 'session-A', 'roles');
  await store.consumeStepUp(valid, id, 'session-A', 'roles');
  await assert.rejects(store.consumeStepUp(valid, id, 'session-A', 'roles'));

  const expired = await store.issueStepUp(id, 'session-A', 'roles');
  const hash = createHash('sha256').update(expired).digest('hex');
  entries.get(`assay:step-up:ticket:${hash}`).expiresAt = Date.now() - 1;
  await assert.rejects(store.consumeStepUp(expired, id, 'session-A', 'roles'));
});

test('verified TOTP code cannot authorize two step-up tickets in same period', async () => {
  const id = `test-${Date.now()}`;
  await store.reserveTotpCode(id, '123456');
  await assert.rejects(store.reserveTotpCode(id, '123456'));
  await authRedis.del(`assay:step-up:totp:${createHash('sha256').update(`${id}:123456`).digest('hex')}`);
});

test('step-up attempts have a per-user rate limit', async () => {
  const id = `test-${Date.now()}-rate`;
  const key = `assay:step-up:attempts:${createHash('sha256').update(id).digest('hex')}`;
  for (let n = 0; n < 5; n++) await store.checkStepUpRate(id);
  assert.ok(entries.get(key).expiresAt > Date.now());
  await assert.rejects(store.checkStepUpRate(id), { status: 429 });
  await authRedis.del(key);
  entries.set(key, { value: '1', expiresAt: Infinity });
  await store.checkStepUpRate(id);
  assert.ok(Number.isFinite(entries.get(key).expiresAt), 'legacy counter without TTL gets repaired');
  await authRedis.del(key);
});

test('account deletion requires its own purpose and blocks the unused callback route', async () => {
  const ticket = await store.issueStepUp('u', 's', 'two-factor');
  const current = { user: { id: 'u' }, session: { token: 's' } };
  const lookup = {
    session: async () => current,
    user: async () => ({ status: 'ACTIVE', twoFactorEnabled: false, roles: [] }),
  };
  await assert.rejects(enforceBetterAuthSensitiveStepUp('/delete-user', new Headers({ 'x-step-up-token': ticket }), lookup), { status: 'FORBIDDEN' });
  await assert.rejects(store.consumeStepUp(ticket, 'u', 's', 'two-factor'));
  const account = await store.issueStepUp('u', 's', 'account');
  await enforceBetterAuthSensitiveStepUp('/delete-user', new Headers({ 'x-step-up-token': account }), lookup);
  await assert.rejects(enforceBetterAuthSensitiveStepUp('/delete-user', new Headers({ 'x-step-up-token': account }), lookup), { status: 'FORBIDDEN' });
  await assert.rejects(enforceBetterAuthSensitiveStepUp('/delete-user', new Headers(), { ...lookup, session: async () => null }), { status: 'UNAUTHORIZED' });
  await assert.rejects(enforceBetterAuthSensitiveStepUp('/delete-user/callback', new Headers(), lookup), { status: 'FORBIDDEN' });
});

test('direct Better Auth guard covers disable, secret disclosure, replacement and backup regeneration', async () => {
  const current = { user: { id: 'u' }, session: { token: 's' } };
  const enrolled = { status: 'ACTIVE', twoFactorEnabled: true, roles: [{ role: { name: 'admin' } }] };
  const calls = [];
  const lookup = {
    session: async () => current,
    user: async () => enrolled,
    consume: async (...args) => { calls.push(args); if (args[0] !== 'valid') throw Error('invalid'); },
  };
  for (const path of ['/two-factor/disable', '/two-factor/get-totp-uri', '/two-factor/enable', '/two-factor/generate-backup-codes']) {
    await assert.rejects(enforceBetterAuthSensitiveStepUp(path, new Headers(), lookup), { status: 'FORBIDDEN' });
    await enforceBetterAuthSensitiveStepUp(path, new Headers({ 'x-step-up-token': 'valid' }), lookup);
  }
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.at(-1), ['valid', 'u', 's', 'two-factor']);
  await assert.rejects(enforceBetterAuthSensitiveStepUp('/two-factor/disable', undefined, lookup), { status: 'UNAUTHORIZED' });
  await assert.rejects(enforceBetterAuthSensitiveStepUp('/two-factor/get-totp-uri', new Headers(), { ...lookup, session: async () => null }), { status: 'UNAUTHORIZED' });
  await assert.rejects(enforceBetterAuthSensitiveStepUp('/two-factor/disable', new Headers({ authorization: 'Bearer ast_fake' }), lookup), { status: 'UNAUTHORIZED' });
});

test('initial enrollment remains available; enforcement is opt-in for privileged users', async () => {
  const previous = process.env.PRIVILEGED_MFA_MODE;
  try {
    delete process.env.PRIVILEGED_MFA_MODE;
    assert.equal(store.privilegedMfaMode(), 'optional');
    const lookup = {
      session: async () => ({ user: { id: 'u' }, session: { token: 's' } }),
      user: async () => ({ status: 'ACTIVE', twoFactorEnabled: false, roles: [{ role: { name: 'admin' } }] }),
      consume: async () => { throw Error('must not consume'); },
    };
    await enforceBetterAuthSensitiveStepUp('/two-factor/enable', new Headers(), lookup);
    await enforceBetterAuthSensitiveStepUp('/two-factor/get-totp-uri', new Headers(), lookup);
    process.env.PRIVILEGED_MFA_MODE = 'enforce';
    assert.equal(store.privilegedMfaMode(), 'enforce');
    await enforceBetterAuthSensitiveStepUp('/two-factor/enable', new Headers(), lookup);
    const enrolled = { ...lookup, user: async () => ({ status: 'ACTIVE', twoFactorEnabled: true, roles: [{ role: { name: 'admin' } }] }) };
    await assert.rejects(enforceBetterAuthSensitiveStepUp('/two-factor/disable', new Headers({ 'x-step-up-token': 'valid' }), enrolled), { status: 'FORBIDDEN' });
  } finally {
    if (previous === undefined) delete process.env.PRIVILEGED_MFA_MODE;
    else process.env.PRIVILEGED_MFA_MODE = previous;
  }
});

test('actual direct Better Auth endpoints reject requests without a session', async () => {
  for (const path of ['/two-factor/disable', '/two-factor/get-totp-uri', '/two-factor/generate-backup-codes', '/delete-user']) {
    const response = await auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
      method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'irrelevant' }),
    }));
    assert.equal(response.status, 401, path);
  }
  const callback = await auth.handler(new Request('http://localhost:3000/api/auth/delete-user/callback?token=fake', {
    method: 'GET', headers: { origin: 'http://localhost:5173' },
  }));
  assert.equal(callback.status, 403);
});

test('Nest role and token mutation handlers require step-up before side effects', async () => {
  let writes = 0;
  const denied = { consume: async () => { throw Error('step-up required'); } };
  const users = new UsersController({ create: async () => { writes++; }, update: async () => { writes++; }, remove: async () => { writes++; }, resetPassword: async () => { writes++; } }, denied);
  const tokens = new ApiTokensController({ create: async () => { writes++; }, rotate: async () => { writes++; } }, denied);
  const req = { headers: {} }, user = { id: 'u', authType: 'session' };
  await assert.rejects(users.create(req, user, { roleNames: ['admin'] }));
  await assert.rejects(users.update(req, user, 'u', { roleNames: ['supervisor'] }));
  await assert.rejects(users.update(req, user, 'u', { status: 'DISABLED' }));
  await assert.rejects(users.remove(req, user, 'u'));
  await assert.rejects(users.resetPassword(req, user, 'u', { newPassword: 'secret' }));
  await assert.rejects(tokens.create(req, user, { name: 'test', scopes: ['ticket:read'] }));
  await assert.rejects(tokens.rotate(req, user, 'token'));
  assert.equal(writes, 0);
});

test('API token authentication cannot issue or consume step-up tickets', async () => {
  const service = new StepUpService({});
  const req = { headers: { authorization: 'Bearer ast_fake', 'x-step-up-token': 'fake' } };
  const user = { id: 'u', authType: 'token', roles: ['admin'] };
  await assert.rejects(service.issue(req, user, { purpose: 'roles', password: 'irrelevant' }), { status: 401 });
  await assert.rejects(service.consume(req, user, 'roles'), { status: 401 });
});

test('an active administrator Web session authorizes management without another credential', async (t) => {
  const service = new StepUpService({});
  const user = { id: 'admin', authType: 'session', roles: ['admin'], twoFactorEnabled: true };
  const origin = (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(',')[0].trim();
  const req = { headers: { origin } };
  t.mock.method(auth.api, 'getSession', async () => ({ user: { id: user.id }, session: { token: 'active-session' } }));
  assert.deepEqual((await service.status(req, user)).stepUpExemptPurposes, ['roles', 'api-tokens', 'samba']);
  for (const purpose of ['roles', 'api-tokens', 'samba']) await service.consume(req, user, purpose);
  for (const purpose of ['account', 'two-factor']) await assert.rejects(service.consume(req, user, purpose), { status: 403 });
  for (const headers of [{}, { origin: 'https://untrusted.example' }, { origin: 'null' }]) {
    await assert.rejects(service.consume({ headers }, user, 'samba'), { status: 403 });
  }
  await assert.rejects(service.consume({ headers: { origin, authorization: 'Bearer fake' } }, user, 'samba'), { status: 401 });
  const legacy = { headers: { 'x-step-up-token': await store.issueStepUp(user.id, 'active-session', 'samba') } };
  await service.consume(legacy, user, 'samba');
  await assert.rejects(service.consume(legacy, user, 'samba'), { status: 403 });
  const previous = process.env.PRIVILEGED_MFA_MODE;
  try {
    process.env.PRIVILEGED_MFA_MODE = 'enforce';
    const unenrolled = await service.status(req, { ...user, twoFactorEnabled: false });
    assert.equal(unenrolled.enrollmentRequired, true);
    assert.deepEqual(unenrolled.stepUpExemptPurposes, []);
  } finally {
    if (previous === undefined) delete process.env.PRIVILEGED_MFA_MODE;
    else process.env.PRIVILEGED_MFA_MODE = previous;
  }
});

test('delegated managers and users whose admin role was removed still need a matching one-use proof', async (t) => {
  const service = new StepUpService({});
  const req = { headers: {} };
  t.mock.method(auth.api, 'getSession', async () => ({ user: { id: 'u' }, session: { token: 's' } }));
  for (const role of ['requester', 'supervisor', 'samba_manager', 'asset_manager', 'inventory_manager']) {
    const user = { id: 'u', authType: 'session', roles: [role] };
    assert.deepEqual((await service.status(req, user)).stepUpExemptPurposes, []);
    await assert.rejects(service.consume(req, user, 'samba'), { status: 403 });
    req.headers['x-step-up-token'] = await store.issueStepUp('u', 's', 'samba');
    await service.consume(req, user, 'samba');
    await assert.rejects(service.consume(req, user, 'samba'), { status: 403 });
    delete req.headers['x-step-up-token'];
  }
});

test('admin exemption cannot authorize an absent, expired or different user session', async (t) => {
  const service = new StepUpService({});
  const user = { id: 'admin', authType: 'session', roles: ['admin'] };
  const getSession = t.mock.method(auth.api, 'getSession', async () => null);
  await assert.rejects(service.consume({ headers: {} }, user, 'samba'), { status: 401 });
  getSession.mock.mockImplementation(async () => ({ user: { id: 'other' }, session: { token: 's' } }));
  await assert.rejects(service.consume({ headers: {} }, user, 'roles'), { status: 401 });
});

test('privileged MFA enforcement blocks app routes only when opted in', async () => {
  const previous = process.env.PRIVILEGED_MFA_MODE;
  const user = { status: 'ACTIVE', roles: ['admin'], twoFactorEnabled: false };
  const guard = new SessionGuard({ getAllAndOverride: () => false }, { getUserFromRequest: async () => user });
  const context = (path) => ({ switchToHttp: () => ({ getRequest: () => ({ path }) }), getHandler: () => null, getClass: () => null });
  try {
    delete process.env.PRIVILEGED_MFA_MODE;
    assert.equal(await guard.canActivate(context('/api/users')), true);
    process.env.PRIVILEGED_MFA_MODE = 'enforce';
    await assert.rejects(guard.canActivate(context('/api/users')), { status: 403 });
    assert.equal(await guard.canActivate(context('/api/me')), true);
    assert.equal(await guard.canActivate(context('/api/me/security')), true);
    user.twoFactorEnabled = true;
    assert.equal(await guard.canActivate(context('/api/users')), true);
  } finally {
    if (previous === undefined) delete process.env.PRIVILEGED_MFA_MODE;
    else process.env.PRIVILEGED_MFA_MODE = previous;
  }
});

test('COP administrators are protected by MFA enforcement and cannot disable enrolled MFA', async () => {
  const previous = process.env.PRIVILEGED_MFA_MODE;
  const context = () => ({ switchToHttp: () => ({ getRequest: () => ({ path: '/api/assets' }) }), getHandler: () => null, getClass: () => null });
  try {
    process.env.PRIVILEGED_MFA_MODE = 'enforce';
    for (const role of ['asset_manager', 'inventory_manager']) {
      const user = { status: 'ACTIVE', roles: [role], twoFactorEnabled: false };
      const guard = new SessionGuard({ getAllAndOverride: () => false }, { getUserFromRequest: async () => user });
      await assert.rejects(guard.canActivate(context()), { status: 403 });
      user.twoFactorEnabled = true;
      assert.equal(await guard.canActivate(context()), true);
      const lookup = {
        session: async () => ({ user: { id: 'u' }, session: { token: 's' } }),
        user: async () => ({ status: 'ACTIVE', twoFactorEnabled: true, roles: [{ role: { name: role } }] }),
        consume: async () => { throw Error('must not consume'); },
      };
      await assert.rejects(enforceBetterAuthSensitiveStepUp('/two-factor/disable', new Headers(), lookup), { status: 'FORBIDDEN' });
    }
  } finally {
    if (previous === undefined) delete process.env.PRIVILEGED_MFA_MODE;
    else process.env.PRIVILEGED_MFA_MODE = previous;
  }
});

test('self-password authorization preserves session, origin and throttling without verifying a second password', async (t) => {
  const user = { id: 'self-password-security', authType: 'session', roles: [], twoFactorEnabled: false };
  const service = new StepUpService({ user: { findUnique: async () => ({ status: 'ACTIVE', twoFactorEnabled: false }) } });
  t.mock.method(auth.api, 'getSession', async () => ({ user: { id: user.id }, session: { token: 'active' } }));
  t.mock.method(auth.api, 'verifyPassword', async () => { throw Error('Must not ask for a local Assay password'); });
  const origin = (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(',')[0].trim();
  for (const headers of [{}, { origin: 'https://untrusted.example' }, { origin: 'null' }]) {
    await assert.rejects(service.preparePasswordChange({ headers }, user), { status: 403 });
  }
  await assert.rejects(service.preparePasswordChange({ headers: { origin, authorization: 'Bearer ast_fake' } }, { ...user, authType: 'token' }), { status: 401 });
  for (let n = 0; n < 5; n++) await service.preparePasswordChange({ headers: { origin } }, user);
  await assert.rejects(service.preparePasswordChange({ headers: { origin } }, user), { status: 429 });
});

test('self-password authorization still requires enrolled TOTP even when the UI user data is stale', async (t) => {
  const user = { id: 'self-password-mfa', authType: 'session', roles: [], twoFactorEnabled: false };
  const service = new StepUpService({
    user: { findUnique: async () => ({ status: 'ACTIVE', twoFactorEnabled: true }) },
    twoFactor: { findUnique: async () => ({ verified: true }) },
  });
  t.mock.method(auth.api, 'getSession', async () => ({ user: { id: user.id }, session: { token: 'active' } }));
  const verify = t.mock.method(auth.api, 'verifyTOTP', async () => ({}));
  const req = { headers: { origin: (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(',')[0].trim() } };
  await assert.rejects(service.preparePasswordChange(req, user), { status: 401 });
  assert.equal(verify.mock.callCount(), 0);
  await service.preparePasswordChange(req, user, '987654');
  assert.equal(verify.mock.callCount(), 1);
  await assert.rejects(service.preparePasswordChange(req, user, '987654'), { status: 403 });
});

test('self-password endpoint uses the existing old-password operation while management keeps its own proof', async () => {
  const { SambaController } = require('../dist/samba/samba.controller');
  let writes = 0, preparations = 0;
  const user = { id: 'self-password-controller', authType: 'session' };
  const body = { requestId: crypto.randomUUID(), old_password: 'OldTestOnly9!', password: 'NewTestOnly9!' };
  const controller = new SambaController({ selfPassword: async (actor, input) => {
    assert.equal(actor, user); assert.deepEqual(input, body); writes++; return { state: 'succeeded' };
  } }, {
    preparePasswordChange: async () => { preparations++; },
    consume: async () => { throw Error('Management still requires its own proof'); },
  });
  await controller.password({ headers: {} }, user, body);
  assert.equal(preparations, 1); assert.equal(writes, 1);
  await assert.rejects(controller.password({ headers: {} }, user, { ...body, old_password: undefined }), { status: 400 });
  await assert.rejects(controller.command({ headers: {} }, user, {}));
  await assert.rejects(controller.bind({ headers: {} }, user, {}));
  assert.equal(writes, 1);
});
