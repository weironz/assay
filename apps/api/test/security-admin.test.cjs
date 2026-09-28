const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const events = [];
const redisPath = require.resolve('../dist/auth/auth-redis');
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true, exports: { authRedis: {} },
};
const authPath = require.resolve('../dist/auth/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { auth: { api: { signUpEmail: async () => {} }, $context: Promise.resolve({
    password: { hash: async () => 'new-hash' },
    internalAdapter: { deleteUserSessions: async (id) => { events.push(`revoke:${id}`); } },
  }) } },
};
const { UsersService } = require('../dist/users/users.service');
const { assertCanLoseActiveAdmin } = require('../dist/auth/last-admin');

test('administrator password reset revokes Better Auth sessions before and after credential change', async () => {
  events.length = 0;
  const prisma = {
    $queryRawUnsafe: async () => [{ ready: true }],
    user: { findUnique: async () => ({ id: 'target' }) },
    $transaction: async (work) => work({ account: {
      findFirst: async () => ({ id: 'account' }),
      update: async ({ data }) => { events.push(`password:${data.password}`); },
    } }),
  };
  const service = new UsersService(prisma);
  assert.deepEqual(await service.resetPassword('target', 'new-password'), { ok: true });
  assert.deepEqual(events, ['revoke:target', 'password:new-hash', 'revoke:target']);
});

test('session revocation failure prevents password replacement', async () => {
  const context = await require('../dist/auth/auth').auth.$context;
  const original = context.internalAdapter.deleteUserSessions;
  let changed = false;
  context.internalAdapter.deleteUserSessions = async () => { throw Error('Redis unavailable'); };
  try {
    const service = new UsersService({
      $queryRawUnsafe: async () => [{ ready: true }],
      user: { findUnique: async () => ({ id: 'target' }) },
      $transaction: async (work) => work({ account: { findFirst: async () => ({ id: 'account' }), update: async () => { changed = true; } } }),
    });
    await assert.rejects(service.resetPassword('target', 'new-password'), /Redis unavailable/);
    assert.equal(changed, false);
  } finally {
    context.internalAdapter.deleteUserSessions = original;
  }
});

test('disabling a user invalidates Better Auth sessions around the status change', async () => {
  events.length = 0;
  const prisma = { user: {
    findUnique: async () => ({ id: 'target', status: 'ACTIVE', twoFactorEnabled: false, roles: [] }),
  }, $transaction: async (work) => work({ user: {
    update: async () => { events.push('disabled'); },
  } }) };
  const service = new UsersService(prisma);
  await service.update('target', { status: 'DISABLED' });
  assert.deepEqual(events, ['revoke:target', 'disabled', 'revoke:target']);
});

test('failed role removal rolls back name, phone and status in the same transaction', async () => {
  events.length = 0;
  let committed = { name: 'old', phone: 'old-phone', status: 'ACTIVE', roles: ['admin'] };
  const prisma = {
    user: {
      findUnique: async () => ({ id: 'target', ...committed, roles: committed.roles.map((name) => ({ role: { name } })), twoFactorEnabled: false }),
      count: async () => 2,
      update: async () => { throw Error('user write escaped transaction'); },
    },
    role: { findMany: async () => { throw Error('role read escaped transaction'); } },
    userRole: { deleteMany: async () => { throw Error('role write escaped transaction'); } },
    $transaction: async (work) => {
      const pending = structuredClone(committed);
      const tx = {
        user: { update: async ({ data }) => { Object.assign(pending, data); events.push('fields:pending'); } },
        role: { findMany: async () => [{ id: 'supervisor-id', name: 'supervisor' }] },
        userRole: {
          findMany: async () => [{ roleId: 'admin-id' }],
          createMany: async () => { pending.roles.push('supervisor'); },
          deleteMany: async () => { throw Error('ASSAY_LAST_ACTIVE_ADMIN'); },
        },
      };
      const result = await work(tx);
      committed = pending;
      return result;
    },
  };
  const service = new UsersService(prisma);
  await assert.rejects(service.update('target', {
    name: 'new', phone: 'new-phone', status: 'DISABLED', roleNames: ['supervisor'],
  }), /ASSAY_LAST_ACTIVE_ADMIN/);
  assert.deepEqual(committed, { name: 'old', phone: 'old-phone', status: 'ACTIVE', roles: ['admin'] });
  assert.deepEqual(events, ['revoke:target', 'fields:pending']);
});

test('failed role assignment rolls back post-signup profile changes', async () => {
  let committed = { id: 'new-user', email: 'new@example.test', username: null, phone: null, emailVerified: false };
  let lookupCount = 0;
  const prisma = {
    user: { findUnique: async () => ++lookupCount === 1 ? null : committed },
    $transaction: async (work) => {
      const pending = structuredClone(committed);
      const result = await work({
        user: { update: async ({ data }) => Object.assign(pending, data) },
        role: { findMany: async () => { throw Error('missing role'); } },
      });
      committed = pending;
      return result;
    },
  };
  const service = new UsersService(prisma);
  await assert.rejects(service.create({
    email: 'new@example.test', password: 'password', name: 'New', username: 'new', phone: '123', roleNames: ['supervisor'],
  }), /missing role/);
  assert.deepEqual(committed, { id: 'new-user', email: 'new@example.test', username: null, phone: null, emailVerified: false });
});

test('last active admin cannot be disabled or deleted', async () => {
  let count = 1;
  const prisma = { user: {
    findUnique: async () => ({ status: 'ACTIVE', roles: [{ role: { name: 'admin' } }] }),
    count: async () => count,
  } };
  await assert.rejects(assertCanLoseActiveAdmin(prisma, 'admin'), { status: 409 });
  count = 2;
  await assertCanLoseActiveAdmin(prisma, 'admin');
  const service = new UsersService({
    user: { ...prisma.user, update: async () => { throw Error('must not update'); }, delete: async () => { throw Error('must not delete'); } },
  });
  count = 1;
  await assert.rejects(service.update('admin', { status: 'DISABLED' }), { status: 409 });
  await assert.rejects(service.remove('admin'), { status: 409 });
});
