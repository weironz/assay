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
test('new AD password validation rejects invalid values before any external write without echoing them', async () => {
  const service = new SambaService({}); let writes = 0;
  service.submit = async () => { writes++; return { state: 'succeeded' }; };
  for (const password of ['short7', 'x'.repeat(513), 'Aa9!bad\0value']) {
    await assert.rejects(() => service.command({}, { requestId: crypto.randomUUID(), action: 'user.password', args: { id: 'a'.repeat(32), password } }), e =>
      e.getStatus() === 400 && e.message.includes('8–512') && !e.message.includes(password));
  }
  assert.equal(writes, 0);
  await service.command({}, { requestId: crypto.randomUUID(), action: 'user.password', args: { id: 'a'.repeat(32), password: 'TestOnlyValid9!Password' } });
  assert.equal(writes, 1);
});
test('employee SMB admission versions track security policy rather than group order or labels', async () => {
  const link = { adObjectId: 'staff-guid', domain: 'DC=assay,DC=test' };
  const share = { name: 'finance', active: true, ready: true, groups: ['finance', 'managers'], read_only: false, comment: 'Original' };
  const data = { domain: link.domain, users: [{ id: link.adObjectId, name: 'alice', dn: 'CN=alice', disabled: false, manageable: true }], shares: [share] };
  const service = new SambaService({ sambaIdentity: { findUnique: async () => link } });
  service.agent = async () => data;
  const initial = (await service.fileIdentity({ id: 'employee' })).sharePolicies.finance;
  share.groups.reverse(); share.comment = 'Updated label';
  assert.equal((await service.fileIdentity({ id: 'employee' })).sharePolicies.finance, initial);
  share.read_only = true;
  assert.notEqual((await service.fileIdentity({ id: 'employee' })).sharePolicies.finance, initial);
  share.read_only = false; share.groups = ['different-team'];
  assert.notEqual((await service.fileIdentity({ id: 'employee' })).sharePolicies.finance, initial);
  share.active = false;
  assert.deepEqual((await service.fileIdentity({ id: 'employee' })).sharePolicies, {});
});
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

test('self-service password changes target only the caller binding and require the current password', async () => {
  const link = { adObjectId: 'a'.repeat(32), domain: 'DC=example,DC=com' };
  const lookups = [], submissions = [];
  const service = new SambaService({ sambaIdentity: { findUnique: async query => { lookups.push(query); return link; } } });
  service.agent = async () => ({ domain: link.domain, users: [{ id: link.adObjectId, disabled: false }] });
  service.submit = async (...args) => { submissions.push(args); return { state: 'succeeded' }; };
  const user = { id: 'caller' };
  const body = { requestId: crypto.randomUUID(), old_password: 'OldTestOnly9!', password: 'NewTestOnly9!' };
  await service.selfPassword(user, body);
  assert.deepEqual(lookups, [{ where: { userId: 'caller' } }]);
  assert.deepEqual(submissions[0], [user, body.requestId, 'user.change_password', { id: link.adObjectId, old_password: body.old_password, password: body.password }]);
  for (const input of [{ ...body, old_password: undefined }, { ...body, id: 'b'.repeat(32) }, { ...body, userId: 'someone-else' }, { ...body, code: 'invalid' }]) {
    await assert.rejects(service.selfPassword(user, input), e => e.getStatus() === 400);
  }
  assert.equal(submissions.length, 1);
  service.submit = async () => { throw new (require('@nestjs/common').BadRequestException)({ code: 'AD_CURRENT_PASSWORD_INVALID' }); };
  await assert.rejects(service.selfPassword(user, body), e => e.getResponse().code === 'AD_CURRENT_PASSWORD_INVALID');
  link.domain = 'DC=other,DC=com';
  service.agent = async () => ({ domain: 'DC=example,DC=com', users: [{ id: link.adObjectId, disabled: false }] });
  await assert.rejects(service.selfPassword(user, body), e => e.getStatus() === 403);
});
