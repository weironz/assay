const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac, randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('redis');

const directory = path.resolve(process.argv[2] || '.oidc-test');
const fixtures = JSON.parse(fs.readFileSync(path.join(directory, 'fixtures.json'), 'utf8'));
assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith('_oidc_test'), 'An isolated OIDC test database is required');
const web = process.env.AUTH_BASE_URL;
const issuer = process.env.OIDC_ISSUER_URL;
assert.equal(new URL(web).hostname, 'localhost', 'This harness is restricted to the local test stack');
assert.equal(new URL(issuer).hostname, 'localhost', 'This harness is restricted to the local Keycloak');
const realm = new URL(issuer).pathname.split('/').at(-1);
assert.equal(realm, 'assay-test', 'Only the generated test realm may be changed');
const keycloak = new URL(issuer).origin;
const db = new PrismaClient(), redis = createClient({ url: process.env.REDIS_URL });
const fixture = kind => fixtures.users.find(user => user.kind === kind);
const checks = [];

class Jar {
  values = new Map();
  get header() { return [...this.values.values()].join('; '); }
  update(response) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0], name = pair.split('=')[0];
      if (/max-age=0(?:;|$)/i.test(line) || pair.endsWith('=')) this.values.delete(name);
      else this.values.set(name, pair);
    }
  }
}
async function send(url, jar, options = {}) {
  const response = await fetch(url, {
    ...options, redirect: 'manual',
    headers: { ...(jar ? { cookie: jar.header } : {}), ...options.headers },
  });
  jar?.update(response);
  return response;
}
const api = (pathname, jar, body, extra = {}) => send(web + '/api' + pathname, jar, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { origin: web, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const decodeHTML = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function authorize(user, app = new Jar(), idp = new Jar(), ticket, denied = false) {
  let start;
  for (let attempt = 0; attempt < 4; attempt++) {
    start = await api(ticket ? '/auth/oidc/link' : '/auth/sign-in/oidc', app, {
      callbackURL: web + (ticket ? '/settings' : '/dashboard'),
    }, ticket ? { 'x-step-up-token': ticket } : {});
    if (start.status !== 429) break;
    console.log('Login rate limit reached; waiting for the normal retry window.');
    const delay = Math.min(60, Math.max(1, Number(start.headers.get('retry-after')) || 60));
    await new Promise(resolve => setTimeout(resolve, delay * 1000));
  }
  assert.equal(start.status, 200, 'Assay must initiate the OIDC flow');
  const { url } = await start.json(), authorization = new URL(url);
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorization.searchParams.get('nonce'));
  let response = await send(url, idp), passwordPrompt = false;
  for (let step = 0; step < 12; step++) {
    if (response.status >= 300 && response.status < 400) {
      const destination = response.headers.get('location');
      if (destination?.startsWith(web + '/api/auth/oidc/callback')) {
        assert.ok(!denied, 'Disabled Keycloak accounts must not receive an authorization code');
        return { app, idp, callback: destination, passwordPrompt, authorization: url };
      }
      assert.equal(new URL(destination).origin, keycloak, 'Unexpected IdP redirect');
      response = await send(destination, idp);
      continue;
    }
    assert.equal(response.status, 200, 'Keycloak must render its actual login form');
    const html = await response.text();
    const form = html.match(/<form\b[^>]*\bid="kc-form-login"[^>]*>/i)?.[0];
    assert.ok(form, 'Expected Keycloak login form');
    const action = decodeHTML(form.match(/\baction="([^"]+)"/i)[1]);
    passwordPrompt = true;
    response = await send(action, idp, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: keycloak },
      body: new URLSearchParams({ username: user.username, password: user.password, credentialId: '' }),
    });
    if (denied) {
      assert.equal(response.status, 200, 'Disabled account must remain on the login form');
      assert.ok((await response.text()).includes('kc-form-login'));
      return { denied: true };
    }
  }
  throw new Error('Keycloak login redirect limit exceeded');
}
async function finish(flow) { return send(flow.callback, flow.app); }
async function me(jar) {
  const response = await api('/me', jar);
  assert.equal(response.status, 200, 'Assay must authenticate the resulting session');
  return response.json();
}
async function login(user, idp) {
  const flow = await authorize(user, new Jar(), idp), response = await finish(flow);
  assert.equal(response.headers.get('location'), web + '/dashboard');
  return { ...flow, current: await me(flow.app), response };
}
async function verifyNoSession(jar) {
  assert.equal((await api('/me', jar)).status, 401, 'No session may be issued before login/MFA completes');
}
function totp(uri) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', value = new URL(uri).searchParams.get('secret');
  let bits = 0, count = 0; const bytes = [];
  for (const letter of value.toUpperCase()) {
    bits = (bits << 5) | alphabet.indexOf(letter); count += 5;
    if (count >= 8) { count -= 8; bytes.push((bits >>> count) & 255); }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function check(name, fn) {
  await fn(); checks.push(name); console.log('PASS:', name);
}

(async () => {
  await redis.connect();
  let adminToken;
  async function admin(endpoint, options = {}, retry = true) {
    if (!adminToken) {
      const response = await fetch(keycloak + '/realms/master/protocol/openid-connect/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'assay-test-admin', password: fixtures.adminPassword }),
      });
      assert.equal(response.status, 200, 'Test Keycloak administrator authentication must succeed');
      adminToken = (await response.json()).access_token;
    }
    const response = await fetch(keycloak + '/admin/realms/' + realm + endpoint, {
      ...options, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    });
    if (response.status === 401 && retry) {
      adminToken = undefined;
      return admin(endpoint, options, false);
    }
    assert.ok(response.ok, 'Keycloak test administration request must succeed');
    return response.status === 204 ? undefined : response.json();
  }
  const ids = {};
  for (const user of fixtures.users) {
    const records = await admin('/users?exact=true&username=' + encodeURIComponent(user.username));
    assert.equal(records.length, 1); ids[user.kind] = records[0].id;
    await admin('/users/' + records[0].id, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  }
  // These are generated fixtures in the isolated database, never real business users.
  await db.user.deleteMany({ where: { email: { in: fixtures.users.map(user => user.email) } } });
  let first, local, linked, recovery;
  await check('real Keycloak discovery and confidential PKCE client', async () => {
    const response = await fetch(issuer + '/.well-known/openid-configuration');
    assert.equal(response.status, 200);
    const metadata = await response.json(); assert.equal(metadata.issuer, issuer);
    assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
    const provider = await api('/auth/oidc/provider');
    assert.equal((await provider.json()).enabled, true);
  });
  await check('real password login, token/JWKS/UserInfo exchange and Redis session', async () => {
    first = await login(fixture('new'));
    assert.equal(first.passwordPrompt, true); assert.equal(first.current.email, fixture('new').email);
    assert.ok(first.response.headers.getSetCookie().some(line => /session_token/.test(line) && /httponly/i.test(line)));
    const session = await api('/auth/get-session', first.app);
    assert.ok(await redis.get((await session.json()).session.token));
    const account = await db.account.findFirst({ where: { userId: first.current.id, providerId: { startsWith: 'oidc:' } } });
    assert.ok(account);
    for (const field of ['accessToken', 'refreshToken', 'idToken']) assert.ok(account[field] === null, 'IdP credentials must not be persisted');
  });
  await check('external realm roles never grant Assay administrator permissions', async () => {
    assert.deepEqual(first.current.roles, ['requester']);
    assert.equal((await api('/assets', first.app)).status, 403);
  });
  await check('Keycloak SSO reuses its session and keeps the same local identity', async () => {
    const second = await login(fixture('new'), first.idp);
    assert.equal(second.passwordPrompt, false); assert.equal(second.current.id, first.current.id);
  });
  await check('missing state Cookie and callback replay are rejected', async () => {
    const flow = await authorize(fixture('new'));
    const missing = await send(flow.callback, new Jar());
    assert.equal(missing.headers.get('location'), web + '/login?oidc_error=1');
    assert.equal((await finish(flow)).headers.get('location'), web + '/dashboard');
    assert.equal((await finish(flow)).headers.get('location'), web + '/login?oidc_error=1');
  });
  await check('same-email local account is protected from implicit linking', async () => {
    local = new Jar();
    const signup = await api('/auth/sign-up/email', local, { email: fixture('local').email, name: 'Local test fixture', password: fixtures.localPassword });
    assert.equal(signup.status, 200); const user = await me(local);
    await db.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    assert.equal((await finish(await authorize(fixture('local')))).headers.get('location'), web + '/login?oidc_error=1');
    assert.equal(await db.account.count({ where: { userId: user.id, providerId: { startsWith: 'oidc:' } } }), 0);
  });
  await check('real local-password step-up authorizes explicit Keycloak linking once', async () => {
    assert.equal((await api('/auth/oidc/link', local, { callbackURL: web + '/settings' })).status, 403);
    const challenge = await api('/me/security/step-up', local, { purpose: 'account', password: fixtures.localPassword });
    assert.equal(challenge.status, 201); const token = (await challenge.json()).stepUpToken;
    const flow = await authorize(fixture('local'), local, new Jar(), token);
    assert.equal((await api('/auth/oidc/link', local, { callbackURL: web + '/settings' }, { 'x-step-up-token': token })).status, 403);
    assert.equal((await finish(flow)).headers.get('location'), web + '/settings?tab=security&oidc_linked=1');
    linked = await login(fixture('local'));
    assert.equal(linked.current.id, (await me(local)).id);
  });
  await check('real TOTP enrollment preserves local MFA after Keycloak login', async () => {
    const enable = await api('/auth/two-factor/enable', linked.app, { password: fixtures.localPassword });
    assert.equal(enable.status, 200); const data = await enable.json(); recovery = data.backupCodes[0];
    const verify = await api('/auth/two-factor/verify-totp', linked.app, { code: totp(data.totpURI) });
    assert.equal(verify.status, 200);
    assert.equal((await me(linked.app)).twoFactorEnabled, true);
    const flow = await authorize(fixture('local')), response = await finish(flow);
    assert.equal(response.headers.get('location'), web + '/login?oidc_mfa=1');
    await verifyNoSession(flow.app);
    const wrong = await api('/auth/two-factor/verify-backup-code', flow.app, { code: 'invalid-recovery-fixture' });
    assert.ok(wrong.status >= 400); await verifyNoSession(flow.app);
    const valid = await api('/auth/two-factor/verify-backup-code', flow.app, { code: recovery });
    assert.equal(valid.status, 200); assert.equal((await me(flow.app)).id, linked.current.id);
    linked = flow;
  });
  await check('used recovery code cannot authenticate a second OIDC MFA challenge', async () => {
    const flow = await authorize(fixture('local'));
    assert.equal((await finish(flow)).headers.get('location'), web + '/login?oidc_mfa=1');
    assert.ok((await api('/auth/two-factor/verify-backup-code', flow.app, { code: recovery })).status >= 400);
    await verifyNoSession(flow.app);
  });
  await check('unverified email and unauthorized email domains cannot provision users', async () => {
    for (const kind of ['unverified', 'outside']) {
      const flow = await authorize(fixture(kind));
      assert.equal((await finish(flow)).headers.get('location'), web + '/login?oidc_error=1');
      assert.equal(await db.user.count({ where: { email: fixture(kind).email } }), 0);
    }
  });
  await check('local account disable immediately revokes existing OIDC sessions', async () => {
    await db.user.update({ where: { id: first.current.id }, data: { status: 'DISABLED', sessionEpoch: { increment: 1 } } });
    await verifyNoSession(first.app);
    assert.equal((await finish(await authorize(fixture('new')))).headers.get('location'), web + '/login?oidc_error=1');
    await db.user.update({ where: { id: first.current.id }, data: { status: 'ACTIVE' } });
    first = await login(fixture('new'));
  });
  await check('Keycloak disable blocks new login; existing local sessions require separate revocation', async () => {
    await admin('/users/' + ids.new, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    try {
      assert.equal((await authorize(fixture('new'), new Jar(), new Jar(), undefined, true)).denied, true);
      assert.equal((await me(first.app)).id, first.current.id);
    } finally { await admin('/users/' + ids.new, { method: 'PUT', body: JSON.stringify({ enabled: true }) }); }
  });
  await check('Keycloak rejects an authorization request without mandatory PKCE', async () => {
    const flow = await authorize(fixture('new')), url = new URL(flow.authorization);
    url.searchParams.delete('code_challenge'); url.searchParams.delete('code_challenge_method');
    const response = await send(url.href, new Jar());
    if (response.status === 302) {
      const error = new URL(response.headers.get('location'));
      assert.equal(error.origin, web);
      assert.ok(error.searchParams.has('error') && !error.searchParams.has('code'), 'Keycloak must reject the missing PKCE challenge');
      assert.equal((await send(error.href, flow.app)).headers.get('location'), web + '/login?oidc_error=1');
    } else assert.equal(response.status, 400);
  });
  await check('wrong client secret fails closed and restores the original test client', async () => {
    const clients = await admin('/clients?clientId=assay'); assert.equal(clients.length, 1);
    const endpoint = '/clients/' + clients[0].id;
    await admin(endpoint, { method: 'PUT', body: JSON.stringify({ secret: randomBytes(32).toString('base64url') }) });
    try {
      assert.equal((await finish(await authorize(fixture('new')))).headers.get('location'), web + '/login?oidc_error=1');
    } finally { await admin(endpoint, { method: 'PUT', body: JSON.stringify({ secret: process.env.OIDC_CLIENT_SECRET }) }); }
    await login(fixture('new'));
  });
  await check('local logout removes the Assay session while Keycloak SSO remains reusable', async () => {
    const loginResult = await login(fixture('new'));
    assert.equal((await api('/auth/sign-out', loginResult.app, {})).status, 200);
    await verifyNoSession(loginResult.app);
    assert.equal((await login(fixture('new'), loginResult.idp)).passwordPrompt, false);
  });
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({
    keycloakVersion: '26.8.1', issuer, web, checks, passed: checks.length,
    testedAt: new Date().toISOString(), isolatedDatabase: 'assay_keycloak_oidc_test',
  }, null, 2) + '\n', { mode: 0o600 });
  console.log('Real Keycloak integration checks passed:', checks.length);
})().catch(error => {
  console.error(error.name + ': ' + error.message); process.exitCode = 1;
}).finally(async () => { await db.$disconnect(); if (redis.isOpen) await redis.quit(); });
