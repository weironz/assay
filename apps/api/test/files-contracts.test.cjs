const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fileCommandSchema, locationSchema, loginSchema, enabledModules } = require('../src/files/contracts');
const { webSessionFingerprint, webSessionScopes } = require('../src/auth/web-session-scope');
test('employee file login accepts a password only, never a caller-selected AD identity', () => {
  assert.equal(loginSchema.safeParse({ password: 'OwnSecret' }).success, true);
  for (const extra of [{ username: 'Administrator' }, { userId: 'other' }, { identity: { id: 'x' } }, { owner: 'x' }])
    assert.equal(loginSchema.safeParse({ password: 'OwnSecret', ...extra }).success, false);
  assert.equal(loginSchema.safeParse({ password: '' }).success, false);
});
test('employee paths reject traversal, alternate streams, UNC and reserved staging paths', () => {
  for (const path of ['../secret', '/etc', 'a\\b', 'a:ads', 'a//b', 'a/..', 'a.', 'a ', 'a\n', '.assay-upload-x', 'dir/.ASSAY-upload-x'])
    assert.equal(locationSchema.safeParse({ share: 'finance', path }).success, false, path);
  assert.equal(locationSchema.safeParse({ share: 'finance', path: '部门/报告.pdf' }).success, true);
  assert.equal(locationSchema.safeParse({ share: 'IPC$', path: '' }).success, false);
  assert.equal(fileCommandSchema.safeParse({ action: 'delete', share: 'finance', path: '' }).success, false);
  assert.equal(fileCommandSchema.safeParse({ action: 'move', share: 'finance', path: 'a', destination: '' }).success, false);
  assert.equal(fileCommandSchema.safeParse({ action: 'delete', share: 'finance', path: 'a', recursive: true }).success, false);
});
test('file modules are opt-in and require the company directory integration', () => {
  const previous = [process.env.SAMBA_ENABLED, process.env.FILES_ENABLED];
  try {
    delete process.env.SAMBA_ENABLED; delete process.env.FILES_ENABLED;
    assert.deepEqual(enabledModules(), { directory: false, files: false });
    process.env.FILES_ENABLED = 'true'; assert.equal(enabledModules().files, false);
    process.env.SAMBA_ENABLED = 'true'; assert.equal(enabledModules().files, true);
    process.env.FILES_ENABLED = 'false'; assert.equal(enabledModules().directory, true); assert.equal(enabledModules().files, false);
  } finally { for (const [i, key] of ['SAMBA_ENABLED', 'FILES_ENABLED'].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; } }
});
test('file capabilities are scoped to individual web sessions without exposing the session token', () => {
  const previous = process.env.AUTH_SECRET; process.env.AUTH_SECRET = 'test-only-secret';
  try {
    const a = webSessionFingerprint('session-a'), b = webSessionFingerprint('session-b');
    assert.notEqual(a, b); assert.match(a, /^[a-f0-9]{64}$/); assert.equal(a.includes('session-a'), false);
    const req = {}; webSessionScopes.set(req, { fingerprint: a, expiresAt: 123 });
    assert.equal(JSON.stringify(req), '{}'); assert.equal(webSessionScopes.get(req).fingerprint, a);
  } finally { if (previous === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = previous; }
});
