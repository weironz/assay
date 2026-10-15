const test = require('node:test');
const assert = require('node:assert/strict');
const { readDirectorySettings } = require('../dist/auth/directory-config');
const { DirectoryClient, directoryProfile, sidString } = require('../dist/auth/directory-client');
const env = {
  DIRECTORY_AUTH_ENABLED: 'true', DIRECTORY_LDAP_URL: 'ldaps://dc.example.test:636',
  DIRECTORY_BASE_DN: 'DC=example,DC=test', DIRECTORY_DOMAIN: 'EXAMPLE.TEST',
  DIRECTORY_BIND_DN: 'CN=reader,DC=example,DC=test', DIRECTORY_BIND_PASSWORD_FILE: '/private/password',
  DIRECTORY_CA_FILE: '/private/ca.crt', AUTH_TRUST_ORIGINS: 'https://assay.example.test', NODE_ENV: 'production',
};
test('local authentication is the default and AD configuration is independent of Samba/files', () => {
  assert.equal(readDirectorySettings({}), null);
  const config = readDirectorySettings(env);
  assert.equal(config.domain, 'example.test'); assert.equal(config.providerId, 'ad:example.test');
  assert.equal(config.url, 'ldaps://dc.example.test:636');
  assert.equal(Object.hasOwn(config, 'password'), false);
  for (const url of ['ldap://dc.example.test', 'ldaps://u:p@dc.example.test', 'ldaps://dc.example.test/other'])
    assert.throws(() => readDirectorySettings({ ...env, DIRECTORY_LDAP_URL: url }));
  assert.throws(() => readDirectorySettings({ ...env, DIRECTORY_DOMAIN: '' }));
  assert.throws(() => readDirectorySettings({ ...env, AUTH_TRUST_ORIGINS: 'https://assay.example.test/path' }));
});
test('SID decoding preserves stable directory identities', () => {
  const sid = Buffer.from('010500000000000515000000010000000200000003000000e8030000', 'hex');
  assert.equal(sidString(sid), 'S-1-5-21-1-2-3-1000');
  assert.throws(() => sidString(sid.subarray(0, 8)));
});
test('GUID lookup preserves non-UTF8 octets and names stay literal LDAP filter values', async () => {
  const client = new DirectoryClient(readDirectorySettings(env));
  const id = '0080fffe0011aabbccddeeff12345678';
  let value;
  client.reader = async action => action({ search: async (_base, options) => {
    if (options.scope === 'sub') { value = options.filter.filters[2].value; return { searchEntries: [{ dn: 'CN=alice,DC=example,DC=test' }] }; }
    return { searchEntries: [entry({ objectGUID: Buffer.from(id, 'hex') })] };
  } });
  assert.equal((await client.profile(id)).id, id); assert(Buffer.isBuffer(value)); assert.deepEqual(value, Buffer.from(id, 'hex'));
  client.verify = async profile => profile;
  await client.authenticate('alice*)(sAMAccountName=*)', 'not-sent-to-network');
  assert.equal(value, 'alice*)(sAMAccountName=*)');
});
function entry(overrides = {}) {
  return { dn: 'CN=alice,DC=example,DC=test', objectGUID: Buffer.alloc(16, 7), sAMAccountName: 'alice', displayName: 'Alice',
    mail: 'Alice@example.test', userAccountControl: '512', pwdLastSet: '133000000000000000', accountExpires: '9223372036854775807',
    tokenGroups: [Buffer.from('010100000000000520000000', 'hex')], ...overrides };
}
test('AD profiles reject disabled, expired, locked, machine and must-change-password accounts', () => {
  const good = directoryProfile(entry());
  assert.equal(good.id, '07'.repeat(16)); assert.equal(good.email, 'alice@example.test');
  for (const overrides of [{ userAccountControl: '514' }, { accountExpires: '1' }, { 'msDS-User-Account-Control-Computed': '16' },
    { 'msDS-User-Account-Control-Computed': '8388608' }, { pwdLastSet: '0' }, { sAMAccountName: 'machine$' }, { objectGUID: 'not-binary' }, { tokenGroups: [] }])
    assert.throws(() => directoryProfile(entry(overrides)));
  assert.notEqual(directoryProfile(entry({ pwdLastSet: '133000000000000001' })).securityStamp, good.securityStamp);
  assert.equal(directoryProfile(entry({ sAMAccountName: 'renamed' })).securityStamp, good.securityStamp);
});

Object.assign(process.env, env);
const redisValues = new Map();
const redisId = require.resolve('../dist/auth/auth-redis');
require.cache[redisId] = { id: redisId, filename: redisId, loaded: true, exports: { authRedis: {
  get: async key => redisValues.get(key) || null,
  set: async (key, value) => { redisValues.set(key, value); return 'OK'; },
} } };
const runtime = require('../dist/auth/directory-runtime');
const { directoryRoleUserIds } = require('../dist/auth/directory-policy');
function dbFixture({ bound = false, collision = false, disabled = false, mismatchedDomain = false } = {}) {
  const calls = { creates: 0, credentialWrites: 0, identity: null };
  const user = { id: 'original-business-user', name: 'Existing employee', email: 'alice@example.test', status: disabled ? 'DISABLED' : 'ACTIVE', sessionEpoch: 0 };
  const db = {
    $queryRaw: async () => [],
    directoryGroupRole: { findMany: async () => [] },
    directoryIdentity: { findUnique: async () => null, upsert: async ({ create }) => { calls.identity = create; } },
    sambaIdentity: { findUnique: async ({ where }) => bound ? { userId: user.id, adObjectId: '07'.repeat(16), domain: mismatchedDomain ? 'DC=other,DC=test' : 'DC=example,DC=test' } : null },
    user: { findUnique: async () => user, findFirst: async () => collision ? user : null, update: async ({ where }) => ({ ...user, id: where.id, sessionEpoch: 1 }),
      create: async ({ data }) => { calls.creates++; return { ...user, ...data, id: 'new-business-user' }; } },
    account: { findUnique: async () => null, create: async ({ data }) => { if (data.password || data.providerId === 'credential') calls.credentialWrites++; } },
    sambaOperation: { create: async () => {} },
  };
  db.$transaction = work => work(db);
  return { db, calls, user };
}
test('explicit AD binding reuses the original business user and never rewrites local credentials', async () => {
  const { db, calls, user } = dbFixture({ bound: true });
  assert.equal((await runtime.resolveDirectoryIdentity(db, directoryProfile(entry()))).id, user.id);
  assert.equal(calls.creates, 0); assert.equal(calls.credentialWrites, 0);
  assert.equal(calls.identity.userId, user.id); assert.deepEqual(calls.identity.roleNames, ['requester']);
});
test('platform administrators can explicitly link an existing business user without enabling Samba', async () => {
  const previous = process.env.SAMBA_ENABLED; process.env.SAMBA_ENABLED = 'false';
  try {
    const { db, calls, user } = dbFixture({ collision: true });
    const result = await runtime.resolveDirectoryIdentity(db, directoryProfile(entry()), { userId: user.id, actorId: 'administrator', actorName: 'Administrator' });
    assert.equal(result.id, user.id); assert.equal(calls.creates, 0); assert.equal(calls.credentialWrites, 0);
    assert.equal(result.sessionEpoch, 1, 'First association revokes old local sessions and pending local MFA challenges');
    assert.equal(calls.identity.userId, user.id);
  } finally { if (previous === undefined) delete process.env.SAMBA_ENABLED; else process.env.SAMBA_ENABLED = previous; }
});
test('first AD login provisions a principal without a second password; email collisions never claim existing accounts', async () => {
  const { db, calls } = dbFixture();
  await runtime.resolveDirectoryIdentity(db, directoryProfile(entry()));
  assert.equal(calls.creates, 1); assert.equal(calls.credentialWrites, 0);
  for (const options of [{ collision: true }, { bound: true, disabled: true }, { bound: true, mismatchedDomain: true }]) {
    const { db, calls } = dbFixture(options);
    await assert.rejects(() => runtime.resolveDirectoryIdentity(db, directoryProfile(entry())));
    assert.equal(calls.creates, 0);
  }
});
test('directory grants are separate from manual roles and group revocation takes effect without changing the business ID', async () => {
  let mappings = [{ roleName: 'handler' }, { roleName: 'inventory_manager' }, { roleName: 'admin' }];
  const profile = directoryProfile(entry());
  const db = {
    directoryGroupRole: { findMany: async () => mappings },
    directoryIdentity: { findUnique: async () => ({ userId: 'u', providerId: 'ad:example.test', objectId: profile.id, accountName: profile.accountName, groupSids: profile.groupSids, roleNames: [] }), update: async () => {} },
  };
  const original = runtime.directoryClient.profile;
  runtime.directoryClient.profile = async () => profile;
  try {
    await runtime.stampDirectorySession({ context: { assayDirectorySession: { userId: 'u', providerId: 'ad:example.test', objectId: profile.id, securityStamp: profile.securityStamp } } }, { userId: 'u', token: 'session-a', expiresAt: new Date(Date.now() + 60000) });
    assert.deepEqual((await runtime.validatedDirectorySession(db, 'session-a', 'u')).roleNames, ['requester', 'handler', 'inventory_manager']);
    mappings = [];
    assert.deepEqual((await runtime.validatedDirectorySession(db, 'session-a', 'u')).roleNames, ['requester']);
    await assert.rejects(() => runtime.validatedDirectorySession(db, 'local-session', 'u'));
    assert.equal(await runtime.validatedDirectorySession({ directoryIdentity: { findUnique: async () => null } }, 'local-session', 'independent-local'), null);
    await assert.rejects(() => runtime.validatedDirectorySession(db, 'session-a', 'other-user'));
    await runtime.stampDirectorySession({ context: { session: { session: { token: 'session-a' } } } }, { userId: 'u', token: 'rotated-session', expiresAt: new Date(Date.now() + 60000) });
    assert.deepEqual((await runtime.validatedDirectorySession(db, 'rotated-session', 'u')).roleNames, ['requester']);
  } finally { runtime.directoryClient.profile = original; redisValues.clear(); }
});
test('staff selectors revalidate directory-derived roles rather than trusting a stale stored grant', async () => {
  const profile = directoryProfile(entry());
  const original = runtime.directoryClient.profile;
  let enabled = true;
  runtime.directoryClient.profile = async () => { if (!enabled) throw Error('disabled'); return profile; };
  const db = {
    directoryGroupRole: { findMany: async () => [{ roleName: 'handler' }] },
    directoryIdentity: {
      findMany: async () => [{ userId: 'staff', user: { roles: [{ roleId: 'manually-granted-handler' }] } }],
      findUnique: async () => ({ userId: 'staff', providerId: 'ad:example.test', objectId: profile.id, accountName: profile.accountName, groupSids: profile.groupSids, roleNames: ['handler'] }),
      update: async () => {},
    },
  };
  try {
    assert.deepEqual(await directoryRoleUserIds(db, ['handler']), ['staff']);
    enabled = false; redisValues.clear();
    assert.deepEqual(await directoryRoleUserIds(db, ['handler']), []);
  } finally { runtime.directoryClient.profile = original; redisValues.clear(); }
});
