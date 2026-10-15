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
test('employee profiles accept standard optional AD data and explicit clearing', () => {
  const base = { id: 'a'.repeat(32), display_name: '王小明', disabled: false };
  assert.equal(actions['user.update'].safeParse(base).success, true);
  assert.equal(actions['user.update'].safeParse({ ...base, profile: { employee_id: 'GS001', email: 'employee@example.com', title: '工程师', department: '研发', phone: '', company: 'GreenStor', office: '' } }).success, true);
  assert.equal(actions['user.update'].safeParse({ ...base, profile: { email: '', department: '' } }).success, true);
  for (const profile of [{ email: 'invalid' }, { employee_id: 'x'.repeat(17) }, { department: '研发\n部' }, { userAccountControl: '512' }]) {
    assert.equal(actions['user.update'].safeParse({ ...base, profile }).success, false);
  }
});
test('batch members are scoped GUIDs, unique and bounded', () => {
  const base = { group_id: 'a'.repeat(32), user_ids: ['b'.repeat(32), 'c'.repeat(32)], add: false };
  assert.equal(actions['group.members'].safeParse(base).success, true);
  for (const user_ids of [[], ['administrator'], ['b'.repeat(32), 'b'.repeat(32)], Array.from({ length: 101 }, (_, n) => n.toString(16).padStart(32, '0'))]) {
    assert.equal(actions['group.members'].safeParse({ ...base, user_ids }).success, false);
  }
  assert.equal(actions['group.members'].safeParse({ ...base, command: 'id' }).success, false);
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
