const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { RolesController } = require('../src/users/roles.controller');
const { SYSTEM_ROLE_NAMES } = require('../src/auth/role-policy');

test('role catalog reports stored permissions read-only in fixed system order', async () => {
  let query;
  const controller = new RolesController({ role: { findMany: async args => {
    query = args;
    return [
      { id: 'a', name: 'admin', description: '管理员', permissions: [{ permission: { code: 'user:manage' } }, { permission: { code: 'ticket:read' } }] },
      { id: 'r', name: 'requester', description: '提单人', permissions: [{ permission: { code: 'ticket:create' } }] },
    ];
  } } });
  const result = await controller.roles();
  assert.deepEqual(query.where.name.in, [...SYSTEM_ROLE_NAMES]);
  assert.deepEqual(query.select.permissions, { select: { permission: { select: { code: true } } } });
  assert.deepEqual(result.map(r => r.name), ['requester', 'admin']);
  assert.deepEqual(result[1].permissions, ['ticket:read', 'user:manage']);
  assert(!JSON.stringify(result).includes('permissionId'));
});
