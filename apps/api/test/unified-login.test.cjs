const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLoginRoute, LoginRejected, LoginDirectoryUnavailable, registrationEnabled, publicRegistrationBlocked } = require('../dist/auth/login-policy');
const settings = { providerId: 'ad:example.test', domain: 'example.test', sambaDomain: 'EXAMPLE' };
const identity = { userId: 'employee', providerId: settings.providerId, objectId: 'a'.repeat(32), accountName: 'alice' };
const local = { id: 'local', email: 'admin@example.test', status: 'ACTIVE', accounts: [{ id: 'credential' }], roles: [{ role: { name: 'admin' } }], directoryIdentity: null };
const db = (users = [], identities = []) => ({ user: { findMany: async () => users }, directoryIdentity: { findMany: async () => identities } });
test('independent local users use the same form with or without an AD provider', async () => {
  for (const provider of [null, settings]) assert.deepEqual(await resolveLoginRoute(db([local]), 'admin@example.test', provider), { source: 'local', email: local.email });
});
test('linked user emails and directory aliases resolve to the immutable directory GUID, even with a retained local hash', async () => {
  assert.deepEqual(await resolveLoginRoute(db([{ ...local, id: 'employee', directoryIdentity: identity }]), 'alias@different.test', settings), { source: 'directory', username: 'alice', objectId: identity.objectId });
  for (const name of ['alice', 'EXAMPLE\\alice']) assert.deepEqual(await resolveLoginRoute(db([], [identity]), name, settings), { source: 'directory', username: 'alice', objectId: identity.objectId });
});
test('unknown accounts go through AD only when enabled, including UPNs; email syntax never chooses local authentication', async () => {
  for (const name of ['new-user', 'person@example.test']) assert.deepEqual(await resolveLoginRoute(db(), name, settings), { source: 'directory', username: name });
  await assert.rejects(resolveLoginRoute(db(), 'unknown@example.test', null), LoginRejected);
});
test('explicitly disabling AD preserves standalone local credentials; changing provider cannot fall back', async () => {
  const user = { ...local, directoryIdentity: identity };
  assert.deepEqual(await resolveLoginRoute(db([user]), local.email, null), { source: 'local', email: local.email });
  await assert.rejects(resolveLoginRoute(db([{ ...user, accounts: [] }]), local.email, null), LoginDirectoryUnavailable);
  await assert.rejects(resolveLoginRoute(db([user]), local.email, { ...settings, providerId: 'ad:other.test' }), LoginDirectoryUnavailable);
});
test('ambiguous case-insensitive aliases and conflicting local/directory identities fail closed', async () => {
  await assert.rejects(resolveLoginRoute(db([local, { ...local, id: 'other' }]), 'ADMIN', settings), LoginRejected);
  await assert.rejects(resolveLoginRoute(db([local], [identity]), 'alice', settings), LoginRejected);
  await assert.rejects(resolveLoginRoute(db([], [identity, { ...identity, userId: 'other' }]), 'alice', settings), LoginRejected);
});
test('a known OIDC-only or disabled account cannot start an unrelated AD login', async () => {
  for (const user of [{ ...local, accounts: [] }, { ...local, status: 'DISABLED' }]) await assert.rejects(resolveLoginRoute(db([user]), local.email, settings), LoginRejected);
});
test('administrator recovery accepts only active, independent local administrators', async () => {
  assert.equal((await resolveLoginRoute(db([local]), local.email, settings, true)).source, 'local');
  for (const user of [{ ...local, directoryIdentity: identity }, { ...local, status: 'DISABLED' }, { ...local, roles: [] }, { ...local, accounts: [] }]) await assert.rejects(resolveLoginRoute(db([user]), local.email, settings, true), LoginRejected);
  await assert.rejects(resolveLoginRoute(db(), 'alice', settings, true), LoginRejected);
});
test('untrusted domain prefixes and control characters never become another authentication authority', async () => {
  for (const name of ['OTHER\\alice', 'EXAMPLE\\alice\\more', 'al\0ice', '']) await assert.rejects(resolveLoginRoute(db(), name, settings), LoginRejected);
});
test('public signup requires an explicit switch while headerless administrator provisioning still works', () => {
  assert.equal(registrationEnabled({}), false); assert.equal(registrationEnabled({ AUTH_ALLOW_REGISTRATION: 'true' }), true);
  assert.equal(publicRegistrationBlocked(false, { request: new Request('http://localhost') }), true);
  assert.equal(publicRegistrationBlocked(false, { headers: new Headers() }), true);
  assert.equal(publicRegistrationBlocked(false, {}), false);
  assert.equal(publicRegistrationBlocked(true, { request: new Request('http://localhost') }), false);
});
