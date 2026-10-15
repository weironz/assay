const test = require('node:test');
const assert = require('node:assert/strict');
const id = require.resolve('../dist/auth/auth-redis');
const values = new Map();
require.cache[id] = { id, filename: id, loaded: true, exports: { authRedis: {
  get: async key => values.get(key) || null,
  getDel: async key => { const value = values.get(key); values.delete(key); return value || null; },
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
