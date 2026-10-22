const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const redisPath = require.resolve('../dist/auth/auth-redis');
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true, exports: { authRedis: {} },
};
const epochPath = require.resolve('../dist/auth/session-epoch');
require.cache[epochPath] = {
  id: epochPath, filename: epochPath, loaded: true,
  exports: { assertSessionEpochMigration: async () => {} },
};

let verifyImpl = async () => false;
const authPath = require.resolve('../dist/auth/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { auth: { $context: Promise.resolve({
    password: { verify: (input) => verifyImpl(input), hash: async () => 'rotated-hash' },
  }) } },
};

const { AuthBootstrapService } = require('../dist/auth/auth-bootstrap.service');
const { SYSTEM_ROLE_NAMES, SYSTEM_ROLE_PERMISSIONS } = require('../dist/auth/role-policy');

// 启动基线校验（#23）要求 DB 角色权限与代码常量一致，这里按常量回填避免误报
const baselineRoles = SYSTEM_ROLE_NAMES.map((name) => ({
  name,
  permissions: SYSTEM_ROLE_PERMISSIONS[name].map((code) => ({ permission: { code } })),
}));

const DEFAULT_ACCOUNTS = [
  { id: 'cred', password: 'stored-hash', user: { id: 'admin-user', email: 'admin@example.com' } },
];

function prismaStub(events, accounts = DEFAULT_ACCOUNTS) {
  return {
    role: { findUnique: async () => ({ id: 'admin-role' }), findMany: async () => baselineRoles },
    user: {
      findUnique: async () => ({ id: 'admin-user', email: 'admin@example.com', username: 'admin' }),
      update: async ({ where, data }) => events.push(`user.update:${where.id}:${JSON.stringify(data)}`),
    },
    userRole: { deleteMany: async () => {}, upsert: async () => {} },
    account: {
      findMany: async () => accounts,
      update: async ({ where, data }) => events.push(`account.update:${where.id}:${data.password}`),
    },
    $transaction: async (ops) => Promise.all(ops),
  };
}

function withNodeEnv(env, run) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  return run().finally(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
}

test('production rotates a legacy default admin password and revokes all sessions', async () => {
  verifyImpl = async ({ password, hash }) => hash === 'stored-hash' && password === 'admin12345';
  const events = [];
  await withNodeEnv('production', () => new AuthBootstrapService(prismaStub(events)).onModuleInit());
  assert.deepEqual(events.filter((e) => e.startsWith('account.update')), ['account.update:cred:rotated-hash']);
  assert.ok(events.some((e) => e.includes('"sessionEpoch":{"increment":1}')), events.join(','));
});

test('production scans every admin-role credential account, including legacy default emails', async () => {
  // 当前 ADMIN_EMAIL 是 root@corp.local，但历史默认路径留下的 legacy@example.com 仍在 admin 角色
  const previousEmail = process.env.ADMIN_EMAIL;
  process.env.ADMIN_EMAIL = 'root@corp.local';
  verifyImpl = async ({ password, hash }) => hash === 'legacy-hash' && password === 'admin12345';
  const events = [];
  const accounts = [
    { id: 'cred-current', password: 'strong-hash', user: { id: 'admin-user', email: 'root@corp.local' } },
    { id: 'cred-legacy', password: 'legacy-hash', user: { id: 'legacy-user', email: 'legacy@example.com' } },
  ];
  try {
    await withNodeEnv('production', () => new AuthBootstrapService(prismaStub(events, accounts)).onModuleInit());
  } finally {
    if (previousEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousEmail;
  }
  assert.deepEqual(
    events.filter((e) => e.startsWith('account.update')),
    ['account.update:cred-legacy:rotated-hash'],
    events.join(','),
  );
  assert.ok(
    events.some((e) => e === 'user.update:legacy-user:{"sessionEpoch":{"increment":1}}'),
    events.join(','),
  );
});

test('production leaves a rotated admin password untouched', async () => {
  verifyImpl = async () => false;
  const events = [];
  await withNodeEnv('production', () => new AuthBootstrapService(prismaStub(events)).onModuleInit());
  assert.equal(events.filter((e) => e.startsWith('account.update')).length, 0);
  assert.ok(!events.some((e) => e.includes('sessionEpoch')));
});

test('development only warns: the local database is never rewritten', async () => {
  verifyImpl = async ({ password, hash }) => hash === 'stored-hash' && password === 'admin12345';
  const events = [];
  await withNodeEnv('development', () => new AuthBootstrapService(prismaStub(events)).onModuleInit());
  assert.equal(events.filter((e) => e.startsWith('account.update')).length, 0);
});
