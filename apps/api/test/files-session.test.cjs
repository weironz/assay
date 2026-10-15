const test = require('node:test');
const assert = require('node:assert/strict');
const id = require.resolve('../dist/auth/auth-redis');
const values = new Map();
const ttls = new Map();
require.cache[id] = { id, filename: id, loaded: true, exports: { authRedis: {
  get: async key => values.get(key) || null,
  getDel: async key => { const value = values.get(key); values.delete(key); return value || null; },
  set: async (key, value, options = {}) => { if (options.NX && values.has(key)) return null; values.set(key, value); return 'OK'; },
  eval: async (_script, { keys, arguments: args = [] }) => {
    if (keys[0].startsWith('assay:files:attempt:')) return 1;
    if (keys[0].startsWith('assay:files:login:')) { values.delete(keys[0]); return 1; }
    const raw = values.get(keys[0]);
    if (keys.length === 1) {
      if (!raw || JSON.parse(raw).token !== args[0]) return null;
      values.delete(keys[0]); return raw;
    }
    if (values.has(keys[1])) return 0;
    if (args[0].startsWith('{')) values.set(keys[0], args[0]);
    else if (!raw || JSON.parse(raw).token !== args[0]) return 0;
    ttls.set(keys[0], Number(args[1])); return 1;
  },
} } };
const { FilesService } = require('../dist/files/files.service');
const { webSessionScopes } = require('../dist/auth/web-session-scope');
test('employee file requests are bound to a web session, current identity and managed share', async () => {
  const previous = [process.env.FILES_ENABLED, process.env.SAMBA_ENABLED];
  process.env.FILES_ENABLED = 'true'; process.env.SAMBA_ENABLED = 'true';
  const linked = { identity: { id: 'ad-a', name: 'alice', dn: 'CN=alice' }, domain: 'domain-a', shares: ['finance'], sharePolicies: { finance: 'policy-a' } };
  let identity = linked, calls = 0;
  const service = new FilesService({ fileIdentity: async () => identity }, {});
  service.gateway = async path => { calls++; return new Response(JSON.stringify(path.startsWith('/v1/list') ? { entries: [] } : { ok: true })); };
  const user = { id: 'employee-a', authType: 'session' };
  const req = { headers: {} }; webSessionScopes.set(req, { fingerprint: 'scope-a', expiresAt: Date.now() + 60000 });
  const cap = { token: 'private-capability', id: 'ad-a', domain: 'domain-a', policies: { finance: 'policy-a' } };
  const reset = () => { values.set('assay:files:session:scope-a', JSON.stringify(cap)); calls = 0; identity = linked; };
  const denied = code => e => e.getStatus() === code;
  try {
    reset(); await assert.rejects(() => service.list(req, { ...user, authType: 'token' }, { share: 'finance', path: '' }), denied(403)); assert.equal(calls, 0);
    await assert.rejects(() => service.list({ headers: {} }, user, { share: 'finance', path: '' }), denied(403));
    const otherSession = { headers: {} }; webSessionScopes.set(otherSession, { fingerprint: 'scope-b', expiresAt: Date.now() + 60000 });
    await assert.rejects(() => service.list(otherSession, user, { share: 'finance', path: '' }), denied(410)); assert.equal(calls, 0);
    assert.deepEqual(await service.list(req, user, { share: 'finance', path: '' }), { entries: [] }); assert.equal(calls, 1);
    reset(); identity = { ...linked, identity: { ...linked.identity, id: 'ad-b' } };
    await assert.rejects(() => service.list(req, user, { share: 'finance', path: '' }), denied(410)); assert.equal(values.has('assay:files:session:scope-a'), false);
    reset(); identity = { ...linked, shares: [], sharePolicies: {} };
    await assert.rejects(() => service.list(req, user, { share: 'finance', path: '' }), denied(410)); assert.equal(values.has('assay:files:session:scope-a'), false);
    reset(); identity = { ...linked, sharePolicies: { finance: 'new-read-only-or-group-policy' } };
    await assert.rejects(() => service.list(req, user, { share: 'finance', path: '' }), denied(410)); assert.equal(values.has('assay:files:session:scope-a'), false);
    reset(); await assert.rejects(() => service.list(req, user, { share: 'unknown-share', path: '' }), denied(403)); assert.equal(calls, 0); assert.equal(values.has('assay:files:session:scope-a'), true);
    reset(); identity = null;
    await assert.rejects(() => service.list(req, user, { share: 'finance', path: '' }), denied(410)); assert.equal(values.has('assay:files:session:scope-a'), false);
    reset(); await assert.rejects(() => service.command(req, user, { action: 'delete', share: 'finance', path: 'report.txt' }), denied(403)); assert.equal(calls, 0);
    reset(); process.env.FILES_ENABLED = 'false';
    await assert.rejects(() => service.list(req, user, { share: 'finance', path: '' }), denied(503)); assert.equal(calls, 0);
  } finally {
    values.clear(); for (const [i, key] of ['FILES_ENABLED', 'SAMBA_ENABLED'].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
  }
});

test('file login and renewal follow the current Web deadline without keeping the AD password', async () => {
  const previous = [process.env.FILES_ENABLED, process.env.SAMBA_ENABLED, process.env.AUTH_TRUST_ORIGINS];
  process.env.FILES_ENABLED = 'true'; process.env.SAMBA_ENABLED = 'true'; process.env.AUTH_TRUST_ORIGINS = 'https://assay.test';
  const linked = { identity: { id: 'ad-a', name: 'alice', dn: 'CN=alice' }, domain: 'domain-a', shares: ['finance'], sharePolicies: { finance: 'policy-a' } };
  const service = new FilesService({ fileIdentity: async () => linked }, {});
  const req = { headers: { origin: 'https://assay.test' } };
  const user = { id: 'employee-a', authType: 'session', passwordSource: 'directory' };
  const key = 'assay:files:session:scope-a';
  const scope = { fingerprint: 'scope-a', expiresAt: Date.now() + 7 * 86400 * 1000 };
  webSessionScopes.set(req, scope);
  let loginBody, sentTtl;
  service.gateway = async (_path, _owner, _cap, init = {}) => {
    if (init.method === 'POST') loginBody = JSON.parse(init.body);
    sentTtl = init.webSessionTtl;
    return new Response(JSON.stringify({ token: 'private-capability', shares: ['finance'], expiresAt: Math.floor(scope.expiresAt / 1000), followsWebSession: true, maxFileBytes: 1000 }));
  };
  try {
    await service.maintain(req, user); assert.equal(loginBody, undefined, 'Business session refresh cannot create a missing SMB connection');
    const body = { password: 'unit-test-only-password' };
    const result = await service.login(req, user, body);
    assert.equal(loginBody.follow_web_session, true); assert(loginBody.ttl > 3600 && loginBody.ttl <= 7 * 86400);
    assert.equal(result.followsWebSession, true); assert.equal(result.token, undefined); assert.equal(body.password, '');
    assert(!values.get(key).includes('unit-test-only-password'));
    assert(ttls.get(key) <= Math.floor((scope.expiresAt - Date.now()) / 1000) + 1);
    // The owner remains signed in after its sliding expiry changes.
    scope.expiresAt = Date.now() + 2 * 86400 * 1000;
    service.gateway = async (_path, _owner, _cap, init = {}) => { sentTtl = init.webSessionTtl; return new Response(JSON.stringify({ shares: ['finance'], expiresAt: Math.floor(scope.expiresAt / 1000), followsWebSession: true })); };
    const status = await service.status(req, user);
    assert(status.connected && status.reconnectWithCompanyLogin); assert.equal(status.token, undefined);
    assert(sentTtl > 3600 && sentTtl <= 2 * 86400); assert(ttls.get(key) <= sentTtl);
    scope.expiresAt = Date.now() + 30_000;
    await service.status(req, user); assert(sentTtl > 0 && sentTtl <= 30); assert(ttls.get(key) <= 30);
    scope.expiresAt = Date.now() - 1;
    await assert.rejects(() => service.status(req, user), error => error.getStatus() === 403);
  } finally {
    values.clear(); ttls.clear(); for (const [i, name] of ['FILES_ENABLED', 'SAMBA_ENABLED', 'AUTH_TRUST_ORIGINS'].entries()) { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }
  }
});

test('in-flight file reads cannot restore signed-out, disconnected or replaced capabilities', async () => {
  const previous = [process.env.FILES_ENABLED, process.env.SAMBA_ENABLED];
  process.env.FILES_ENABLED = 'true'; process.env.SAMBA_ENABLED = 'true';
  const linked = { identity: { id: 'ad-a', name: 'alice', dn: 'CN=alice' }, domain: 'domain-a', shares: ['finance'], sharePolicies: { finance: 'policy-a' } };
  const service = new FilesService({ fileIdentity: async () => linked }, {});
  const user = { id: 'employee-a', authType: 'session', passwordSource: 'directory' };
  const req = { headers: {} }; webSessionScopes.set(req, { fingerprint: 'scope-a', expiresAt: Date.now() + 86400_000 });
  const key = 'assay:files:session:scope-a', closed = 'assay:files:closed:scope-a';
  const cap = { token: 'original', id: 'ad-a', domain: 'domain-a', policies: { finance: 'policy-a' } };
  const replacement = JSON.stringify({ ...cap, token: 'replacement' });
  const reset = () => { values.clear(); values.set(key, JSON.stringify(cap)); };
  const denied = error => error.getStatus() === 410;
  try {
    for (const stop of [() => values.delete(key), () => values.set(closed, '1'), () => values.set(key, replacement)]) {
      reset(); service.gateway = async path => { if (path.startsWith('/v1/list')) stop(); return new Response(JSON.stringify({ entries: [] })); };
      await assert.rejects(() => service.list(req, user, { share: 'finance', path: '' }), denied);
      assert([undefined, replacement].includes(values.get(key)));
    }
    reset(); service.gateway = async path => {
      if (path.startsWith('/v1/list')) { values.set(key, replacement); return new Response(JSON.stringify({ error: '文件会话已失效' }), { status: 410 }); }
      return new Response('{}');
    };
    await assert.rejects(() => service.list(req, user, { share: 'finance', path: '' }), denied);
    assert.equal(values.get(key), replacement, 'A late 410 cannot revoke a newer connection');
  } finally {
    values.clear(); ttls.clear(); for (const [i, name] of ['FILES_ENABLED', 'SAMBA_ENABLED'].entries()) { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }
  }
});

test('the unified agent file route uses its own service key and preserves the path prefix', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-unified-files-'));
  const file = path.join(root, 'token'); fs.writeFileSync(file, 'e'.repeat(48), { mode: 0o600 });
  const previous = [process.env.FILES_GATEWAY_URL, process.env.FILES_GATEWAY_TOKEN_FILE], originalFetch = global.fetch;
  process.env.FILES_GATEWAY_TOKEN_FILE = file;
  const service = new FilesService({}, {}); let request;
  global.fetch = async (url, init) => { request = { url, init }; return new Response('{}'); };
  try {
    process.env.FILES_GATEWAY_URL = 'http://agent:8080/files';
    await service.gateway('/v1/list?share=qa&path=', 'owner', { token: 'employee-capability' });
    assert.equal(request.url, 'http://agent:8080/files/v1/list?share=qa&path=');
    assert.equal(request.init.headers.Authorization, 'Bearer ' + 'e'.repeat(48));
    assert.equal(request.init.headers['X-File-Session'], 'employee-capability');
    for (const url of ['http://outside.example/files', 'http://agent.attacker.example/files', 'file:///private/token', 'http://user:pass@agent:8080/files']) {
      process.env.FILES_GATEWAY_URL = url;
      await assert.rejects(() => service.gateway('/v1/session', 'owner', null), error => error.getStatus() === 503);
    }
  } finally {
    global.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true });
    for (const [i, name] of ['FILES_GATEWAY_URL', 'FILES_GATEWAY_TOKEN_FILE'].entries()) { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }
  }
});
