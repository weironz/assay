const { test } = require('node:test');
const assert = require('node:assert/strict');
const { actions, commandSchema, directoryPath, metadata, bindingSchema } = require('../src/samba/contracts');
test('Samba requests cannot expose arbitrary shell, credentials or paths', () => {
  assert.equal(commandSchema.safeParse({ requestId: crypto.randomUUID(), action: 'exec', args: { command: 'id' } }).success, false);
  assert.equal(actions['user.create'].safeParse({ name: 'alice', display_name: 'Alice', password: 'Secret123!', command: 'id' }).success, false);
  for (const path of ['../private', '/etc', 'a/../../b', 'a\\b', 'a//b']) assert.equal(directoryPath.safeParse({ share: 'finance', path }).success, false);
  assert.equal(directoryPath.safeParse({ share: 'finance', path: '资料/2026' }).success, true);
  assert.equal(bindingSchema.safeParse({ userId: 'alice', adObjectId: 'administrator' }).success, false);
});
test('Samba audit metadata contains no password or machine credential', () => {
  const value = metadata({ id: 'ad-object', password: 'SECRET', old_password: 'OLD', token: 'TOKEN', mode: 'read' });
  assert.deepEqual(value, { id: 'ad-object', mode: 'read' });
});
const { SambaService } = require('../src/samba/samba.service');
test('running asynchronous jobs remain running while reconciled', async () => {
  const updates = [];
  const db = { sambaOperation: {
    findUnique: async () => ({ id: 'job', action: 'acl.grant', state: 'queued', actorId: 'owner' }),
    update: async value => { updates.push(value); return value.data; },
  } };
  const service = new SambaService(db);
  service.agent = async () => ({ request_id: 'job', state: 'running' });
  await service.operation('job');
  assert.equal(updates[0].data.state, 'running');
});
test('employee polling cannot access another actor operation', async () => {
  const service = new SambaService({ sambaOperation: { findUnique: async () => ({ actorId: 'someone-else' }) } });
  await assert.rejects(() => service.ownOperation({ id: 'requester' }, 'job'), error => error.getStatus() === 403);
});
