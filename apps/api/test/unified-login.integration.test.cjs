const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const url = process.env.UNIFIED_LOGIN_TEST_DATABASE_URL;
if (!url) test('unified login integration requires an isolated PostgreSQL URL', { skip: true }, () => {});
else {
  assert.match(new URL(url).pathname, /_unified_login_test$/);
  Object.assign(process.env, { DATABASE_URL: url, AUTH_BASE_URL: 'http://localhost:3000', AUTH_TRUST_ORIGINS: 'http://localhost:5173',
    AUTH_SECRET: 'unified-login-isolated-test-only-secret-20261016', REQUIRE_EMAIL_VERIFICATION: 'false', AUTH_ALLOW_REGISTRATION: 'false',
    DIRECTORY_AUTH_ENABLED: 'true', DIRECTORY_LDAP_URL: 'ldaps://not-used.example.test:636', DIRECTORY_BASE_DN: 'DC=example,DC=test', DIRECTORY_DOMAIN: 'example.test',
    DIRECTORY_BIND_DN: 'CN=reader,DC=example,DC=test', DIRECTORY_BIND_PASSWORD_FILE: '/not-used', DIRECTORY_CA_FILE: '/not-used',
    SAMBA_ENABLED: 'true', FILES_ENABLED: 'true', NODE_ENV: 'test' });
  delete process.env.SMTP_HOST;
  const { PrismaClient } = require('@prisma/client'); const db = new PrismaClient();
  const runtime = require('../dist/auth/directory-runtime');
  const { DirectoryRejected, DirectoryUnavailable } = require('../dist/auth/directory-client');
  const { assertSessionEpochMigration } = require('../dist/auth/session-epoch');
  const { authRedis } = require('../dist/auth/auth-redis');
  const { auth } = require('../dist/auth/auth');
  const profiles = new Map(); let failure = '', directoryAttempts = 0, fileConnections = 0, ip = 1;
  runtime.directoryClient.profile = async id => {
    if (failure === 'unavailable') throw new DirectoryUnavailable();
    const profile = profiles.get(id); if (!profile) throw new DirectoryRejected(); return profile;
  };
  runtime.directoryClient.verify = async (profile, password) => {
    directoryAttempts++; if (failure === 'unavailable') throw new DirectoryUnavailable();
    if (password !== 'directory-test-only-password') throw new DirectoryRejected(); return profile;
  };
  runtime.directoryClient.authenticate = async (name, password) => {
    const profile = [...profiles.values()].find(p => p.accountName === name || p.email === name);
    return runtime.directoryClient.verify(profile || {}, password);
  };
  runtime.registerDirectoryFileConnector(async (_session, password) => { assert.equal(password, 'directory-test-only-password'); fileConnections++; });
  const post = (path, body, cookie = '', origin = 'http://localhost:5173') => auth.handler(new Request('http://localhost:3000/api/auth' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-real-ip': `127.0.${Math.floor(ip / 200)}.${++ip % 200 + 1}`, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const cookies = response => response.headers.getSetCookie().map(line => line.split(';', 1)[0]).join('; ');
  const session = async cookie => {
    const response = await auth.handler(new Request('http://localhost:3000/api/auth/get-session', { headers: { cookie } }));
    return response.json();
  };
  const signup = async name => {
    const email = `${name}-${randomUUID()}@example.test`;
    const user = await auth.api.signUpEmail({ body: { email, password: 'local-test-only-password', name } });
    return db.user.findUniqueOrThrow({ where: { email } });
  };
  const totpCode = uri => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, count = 0; const bytes = [];
    for (const letter of new URL(uri).searchParams.get('secret').toUpperCase()) { bits = (bits << 5) | alphabet.indexOf(letter); count += 5; if (count >= 8) { count -= 8; bytes.push((bits >>> count) & 255); } }
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(); const offset = digest.at(-1) & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
  };
  let local, employee, admin;
  test.before(async () => {
    await assertSessionEpochMigration(db);
    await db.role.createMany({ data: [{ name: 'requester' }, { name: 'admin' }], skipDuplicates: true });
    local = await signup('local'); admin = await signup('admin'); employee = await signup('employee');
    const adminRole = await db.role.findUniqueOrThrow({ where: { name: 'admin' } });
    await db.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
    const id = randomUUID().replaceAll('-', '');
    profiles.set(id, { id, accountName: 'employee', dn: 'CN=Employee,DC=example,DC=test', name: 'Employee', email: employee.email, groupSids: ['S-1-5-21-1-2-3-513'], securityStamp: 'verified-test-stamp' });
    await runtime.resolveDirectoryIdentity(db, profiles.get(id), { userId: employee.id, actorId: admin.id, actorName: 'Admin' });
  });
  test.after(async () => { await db.$disconnect(); await authRedis.quit(); });
  test('public registration is closed while internal administrator account provisioning succeeds', async () => {
    assert(local && admin && employee);
    const response = await post('/sign-up/email', { email: 'must-not-exist@example.test', name: 'Rejected', password: 'not-used-test-only' });
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'REGISTRATION_DISABLED');
    assert.equal(await db.user.count({ where: { email: 'must-not-exist@example.test' } }), 0);
  });
  test('explicit registration enablement opens both the advertised option and the guarded signup endpoint', async () => {
    process.env.AUTH_ALLOW_REGISTRATION = 'true';
    try {
      const options = await auth.handler(new Request('http://localhost:3000/api/auth/login/options'));
      assert.equal((await options.json()).registrationEnabled, true);
      const response = await post('/sign-up/email', { email: 'explicit-registration@example.test', name: 'Explicit registration', password: 'local-test-only-password' });
      assert.equal(response.status, 200); assert((await session(cookies(response)))?.session);
    } finally { process.env.AUTH_ALLOW_REGISTRATION = 'false'; }
  });
  test('local unified sign-in forwards real cookies and a valid epoch without contacting AD', async () => {
    const before = directoryAttempts;
    const response = await post('/sign-in/unified', { username: local.email.toUpperCase(), password: 'local-test-only-password' });
    assert.equal(response.status, 200); assert.equal((await session(cookies(response))).user.id, local.id); assert.equal(directoryAttempts, before);
  });
  test('employee email aliases use AD and establish files; a wrong AD password never falls back to the retained local password', async () => {
    const before = fileConnections;
    const response = await post('/sign-in/unified', { username: employee.email, password: 'directory-test-only-password' });
    assert.equal(response.status, 200); assert.equal((await response.json()).filesConnected, true);
    assert.equal((await session(cookies(response))).user.id, employee.id); assert.equal(fileConnections, before + 1);
    assert.equal((await post('/sign-in/unified', { username: employee.email, password: 'local-test-only-password' })).status, 401);
    assert.equal((await post('/sign-in/email', { email: employee.email, password: 'local-test-only-password' })).status, 401);
  });
  test('AD outage leaves both normal local admin login and emergency login usable', async () => {
    failure = 'unavailable';
    try {
      assert.equal((await post('/sign-in/unified', { username: employee.email, password: 'directory-test-only-password' })).status, 503);
      for (const path of ['/sign-in/unified', '/sign-in/local-admin']) {
        const response = await post(path, { username: admin.email, password: 'local-test-only-password' });
        assert.equal(response.status, 200); assert.equal((await session(cookies(response))).user.id, admin.id);
      }
    } finally { failure = ''; }
  });
  test('recovery rejects employees and linked directory identities even with a valid retained local password', async () => {
    for (const user of [local, employee]) assert.equal((await post('/sign-in/local-admin', { username: user.email, password: 'local-test-only-password' })).status, 401);
  });
  test('unified authentication rejects untrusted origins without issuing any session cookie', async () => {
    const response = await post('/sign-in/unified', { username: admin.email, password: 'local-test-only-password' }, '', 'http://evil.example.test');
    assert.equal(response.status, 403); assert.equal(cookies(response), '');
  });
  test('local MFA survives dispatch: no session before TOTP, real challenge cookie and final epoch after TOTP', async () => {
    const first = await post('/sign-in/unified', { username: local.email, password: 'local-test-only-password' });
    const enabled = await post('/two-factor/enable', { password: 'local-test-only-password' }, cookies(first));
    assert.equal(enabled.status, 200); const { totpURI } = await enabled.json();
    const enrolled = await post('/two-factor/verify-totp', { code: totpCode(totpURI) }, cookies(first)); assert.equal(enrolled.status, 200);
    const login = await post('/sign-in/unified', { username: local.email, password: 'local-test-only-password' });
    assert.equal(login.status, 200); assert.equal((await login.json()).twoFactorRedirect, true);
    assert.equal(await session(cookies(login)), null);
    const final = await post('/two-factor/verify-totp', { code: totpCode(totpURI) }, cookies(login));
    assert.equal(final.status, 200); assert.equal((await session(cookies(final))).user.id, local.id);
  });
  test('directory MFA still requires its second factor before issuing a file connection or session', async () => {
    const first = await post('/sign-in/unified', { username: employee.email, password: 'directory-test-only-password' });
    const enabled = await post('/two-factor/enable', { password: 'directory-test-only-password' }, cookies(first));
    assert.equal(enabled.status, 200); const { totpURI } = await enabled.json();
    const enrolled = await post('/two-factor/verify-totp', { code: totpCode(totpURI) }, cookies(first)); assert.equal(enrolled.status, 200);
    const count = fileConnections;
    const challenge = await post('/sign-in/unified', { username: employee.email, password: 'directory-test-only-password' });
    assert.equal(challenge.status, 200); assert.equal((await challenge.json()).twoFactorRequired, true); assert.equal(cookies(challenge), ''); assert.equal(fileConnections, count);
    const final = await post('/sign-in/unified', { username: employee.email, password: 'directory-test-only-password', code: totpCode(totpURI) });
    assert.equal(final.status, 200); assert.equal((await session(cookies(final))).user.id, employee.id); assert.equal(fileConnections, count + 1);
  });
}
