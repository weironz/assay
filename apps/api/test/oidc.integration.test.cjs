const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash, generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const isolated = process.env.OIDC_TEST_DATABASE_URL;

if (!isolated) {
  test('OIDC integration requires an isolated PostgreSQL URL', { skip: true }, () => {});
} else {
  assert.match(new URL(isolated).pathname, /_oidc_test$/, 'Refuse to run against a live database');
  process.env.AUTH_ALLOW_REGISTRATION = 'true';
  process.env.DATABASE_URL = isolated;
  process.env.AUTH_BASE_URL = 'http://localhost:3000';
  process.env.AUTH_TRUST_ORIGINS = 'http://localhost:5173';
  process.env.AUTH_SECRET = 'oidc-test-only-long-random-secret-20261014';
  process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_CLIENT_ID = 'assay-test';
  process.env.OIDC_CLIENT_SECRET = 'oidc-test-client-secret';
  process.env.OIDC_DISPLAY_NAME = 'SSO';
  process.env.OIDC_AUTO_PROVISION = 'true';
  process.env.OIDC_EMAIL_DOMAINS = '';
  process.env.OIDC_TOKEN_AUTH_METHOD = 'client_secret_basic';
  process.env.OIDC_ALLOW_HTTP = 'true';
  process.env.NODE_ENV = 'test';
  delete process.env.SMTP_HOST;
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  const { authRedis } = require('../src/auth/auth-redis');
  const { issueStepUp } = require('../src/auth/step-up-store');
  const { readOidcSettings } = require('../src/auth/oidc-config');
  const { OidcClient } = require('../src/auth/oidc-client');
  const { resolveOidcIdentity } = require('../src/auth/oidc-identity');
  let auth, issuer, server, key, otherKey, settings;
  let selected, fault = '', requestId = 1, tokenRequests = 0;
  const codes = new Map(), profiles = new Map(), createdEmails = new Set();
  const uniqueProfile = () => {
    const profile = { sub: randomUUID(), email: `oidc-${randomUUID()}@example.test`, name: 'OIDC fixture', email_verified: true };
    createdEmails.add(profile.email);
    return profile;
  };
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const jwt = (claims, invalid = false) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), invalid ? otherKey.privateKey : key.privateKey).toString('base64url')}`;
  };
  test.before(async () => {
    key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, issuer);
        if (url.pathname.endsWith('/.well-known/openid-configuration')) return json(res, {
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: `${issuer}/userinfo`, response_types_supported: ['code'], subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        });
        if (url.pathname.endsWith('/jwks')) return json(res, { keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] });
        if (url.pathname.endsWith('/authorize')) {
          assert.equal(url.searchParams.get('response_type'), 'code');
          assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
          assert.ok(url.searchParams.get('scope').split(' ').includes('openid'));
          assert.ok(url.searchParams.get('nonce'));
          const code = randomUUID();
          codes.set(code, { params: url.searchParams, profile: { ...selected }, fault });
          const redirect = new URL(url.searchParams.get('redirect_uri'));
          redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state'));
          res.writeHead(302, { location: redirect.href }); return res.end();
        }
        if (url.pathname.endsWith('/token')) {
          tokenRequests++;
          let raw = ''; for await (const chunk of req) raw += chunk;
          const params = new URLSearchParams(raw), record = codes.get(params.get('code'));
          codes.delete(params.get('code'));
          if (!record) return json(res, { error: 'invalid_grant' }, 400);
          const basic = req.headers.authorization?.startsWith('Basic ')
            ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(value => decodeURIComponent(value.replace(/\+/g, ' ')))
            : [];
          const basicAuth = basic[0] === 'assay-test' && basic[1] === 'oidc-test-client-secret';
          const postAuth = params.get('client_id') === 'assay-test' && params.get('client_secret') === 'oidc-test-client-secret';
          if (!basicAuth && !postAuth) return json(res, { error: 'invalid_client' }, 401);
          assert.equal(params.get('grant_type'), 'authorization_code');
          assert.equal(params.get('redirect_uri'), record.params.get('redirect_uri'));
          assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), record.params.get('code_challenge'));
          const now = Math.floor(Date.now() / 1000);
          const claims = { iss: issuer, aud: 'assay-test', exp: now + 300, iat: now, nonce: record.params.get('nonce'), ...record.profile };
          if (record.fault === 'issuer') claims.iss = 'https://attacker.test';
          if (record.fault === 'audience') claims.aud = 'another-app';
          if (record.fault === 'expired') claims.exp = now - 1000;
          if (record.fault === 'nonce') claims.nonce = 'wrong-nonce';
          const access = randomUUID();
          profiles.set(access, record.fault === 'userinfo-sub' ? { ...record.profile, sub: 'wrong-sub' } : record.profile);
          return json(res, { access_token: access, token_type: 'Bearer', expires_in: 300, ...(record.fault === 'missing-id-token' ? {} : { id_token: jwt(claims, record.fault === 'signature') }) });
        }
        if (url.pathname.endsWith('/userinfo')) return json(res, profiles.get(req.headers.authorization?.slice(7)) || {}, 200);
        return json(res, {}, 404);
      } catch { return json(res, { error: 'fixture_failed' }, 500); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${server.address().port}/realm`;
    process.env.OIDC_ISSUER_URL = issuer;
    settings = readOidcSettings();
    await db.role.upsert({ where: { name: 'requester' }, update: {}, create: { name: 'requester', description: 'Test requester' } });
    auth = require('../src/auth/auth').auth;
    await authRedis.ping();
  });
  test.after(async () => {
    for (const email of createdEmails) await db.user.deleteMany({ where: { email } });
    await db.$disconnect();
    if (authRedis.isOpen) await authRedis.quit();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const cookies = (res, previous = '') => {
    const jar = new Map(previous.split('; ').filter(Boolean).map(pair => [pair.split('=')[0], pair]));
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0], name = pair.split('=')[0];
      if (/max-age=0/i.test(line)) jar.delete(name); else jar.set(name, pair);
    }
    return [...jar.values()].join('; ');
  };
  const request = (path, body, cookie = '', extra = {}) => auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', 'x-real-ip': `192.0.2.${requestId++}`, cookie, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const start = async (profile, mode = '', cookie = '', linkToken) => {
    selected = profile; fault = mode;
    const res = await request(linkToken ? '/oidc/link' : '/sign-in/oidc', { callbackURL: `http://localhost:5173/${linkToken ? 'settings' : 'dashboard'}` }, cookie, typeof linkToken === 'string' ? { 'x-step-up-token': linkToken } : {});
    assert.equal(res.status, 200, await res.clone().text());
    const { url } = await res.json();
    const authorize = await fetch(url, { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    return { callback: authorize.headers.get('location'), cookie: cookies(res, cookie), url };
  };
  const callback = (flow, cookie = flow.cookie) => request(new URL(flow.callback).pathname.replace('/api/auth', '') + new URL(flow.callback).search, undefined, cookie);
  const session = async cookie => {
    const res = await request('/get-session', undefined, cookie);
    return res.status === 200 ? res.json() : null;
  };
  const login = async profile => {
    const flow = await start(profile);
    const res = await callback(flow);
    assert.equal(res.status, 302); assert.equal(res.headers.get('location'), 'http://localhost:5173/dashboard');
    const cookie = cookies(res, flow.cookie), current = await session(cookie);
    assert.ok(current?.user?.id);
    return { cookie, current, res, flow };
  };

  test('public provider configuration exposes no credentials and callbacks reject open redirects', async () => {
    const res = await request('/oidc/provider');
    assert.deepEqual(await res.json(), { enabled: true, name: 'SSO' });
    assert.equal((await request('/sign-in/oidc', { callbackURL: 'https://attacker.test/dashboard' })).status, 400);
    assert.equal((await request('/sign-in/oidc', { callbackURL: 'http://localhost:5173/dashboard?next=evil' })).status, 400);
    assert.equal((await request('/sign-in/oidc', { callbackURL: 'http://localhost:5173/dashboard' }, '', { origin: 'https://attacker.test' })).status, 403);
  });
  test('full discovery/PKCE/nonce/JWKS flow creates a requester and an httpOnly Redis session without retaining tokens', async () => {
    const profile = uniqueProfile(), first = await login(profile);
    assert.ok(first.res.headers.getSetCookie().some(value => /session_token/.test(value) && /httponly/i.test(value)));
    assert.ok(await authRedis.get(first.current.session.token));
    const user = await db.user.findUnique({ where: { id: first.current.user.id }, include: { roles: { include: { role: true } }, accounts: true } });
    assert.deepEqual(user.roles.map(r => r.role.name), ['requester']);
    assert.equal(user.accounts[0].providerId, settings.providerId);
    for (const field of ['accessToken', 'refreshToken', 'idToken', 'password']) assert.equal(user.accounts[0][field], null);
    assert.equal((await request('/unlink-account', { providerId: settings.providerId }, first.cookie)).status, 400, 'the sole login identity remains protected by Better Auth, not a second challenge');
    const second = await login({ ...profile, email: `renamed-${randomUUID()}@example.test` });
    assert.equal(second.current.user.id, first.current.user.id, 'identity uses issuer + sub, not mutable email');
  });
  for (const mode of ['signature', 'issuer', 'audience', 'expired', 'nonce', 'missing-id-token', 'userinfo-sub']) {
    test(`invalid ${mode} rejects login before creating a user or session`, async () => {
      const profile = uniqueProfile(), flow = await start(profile, mode), res = await callback(flow);
      assert.equal(res.headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
      assert.equal(await db.user.findUnique({ where: { email: profile.email } }), null);
      assert.equal(await session(cookies(res, flow.cookie)), null);
    });
  }
  test('unverified or missing email is rejected; IdP denial remains a generic login error', async () => {
    for (const profile of [{ ...uniqueProfile(), email_verified: false }, { ...uniqueProfile(), email: undefined }]) {
      const flow = await start(profile), res = await callback(flow);
      assert.equal(res.headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
    }
    const flow = await start(uniqueProfile()), url = new URL(flow.callback);
    url.searchParams.delete('code'); url.searchParams.set('error', 'access_denied');
    const res = await callback({ ...flow, callback: url.href });
    assert.equal(res.headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
  });
  test('missing/wrong browser cookies, state tampering and concurrent replay never create multiple sessions', async () => {
    const flow = await start(uniqueProfile()), before = tokenRequests;
    assert.equal((await callback(flow, '')).headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
    assert.equal(tokenRequests, before);
    const url = new URL(flow.callback); url.searchParams.set('state', randomUUID());
    assert.equal((await callback({ ...flow, callback: url.href })).headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
    const results = await Promise.all([callback(flow), callback(flow)]);
    assert.equal(results.filter(res => res.headers.get('location') === 'http://localhost:5173/dashboard').length, 1);
    assert.equal(tokenRequests, before + 1);
    assert.equal((await callback(flow)).headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
  });
  test('same-email accounts need explicit trusted-session linking; no second challenge and legacy proof replay is still rejected', async () => {
    const profile = uniqueProfile();
    const signup = await request('/sign-up/email', { email: profile.email, name: 'Local fixture', password: 'local-test-password' });
    assert.equal(signup.status, 200, await signup.clone().text());
    const cookie = cookies(signup), current = await session(cookie);
    await db.user.update({ where: { id: current.user.id }, data: { emailVerified: true } });
    const failed = await callback(await start(profile));
    assert.equal(failed.headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
    assert.equal((await request('/oidc/link', { callbackURL: 'http://localhost:5173/settings' })).status, 401);
    assert.equal((await request('/oidc/link', { callbackURL: 'http://localhost:5173/settings' }, cookie, { origin: 'https://untrusted.test' })).status, 403);
    const flow = await start(profile, '', cookie, true);
    const linked = await callback(flow);
    assert.equal(linked.headers.get('location'), 'http://localhost:5173/settings?tab=security&oidc_linked=1');
    assert.equal((await login(profile)).current.user.id, current.user.id);
    const info = await request('/oidc/account', undefined, cookie);
    assert.equal((await info.json()).linked, true);
    const token = await issueStepUp(current.user.id, current.session.token, 'account');
    assert.equal((await request('/oidc/link', { callbackURL: 'http://localhost:5173/settings' }, cookie, { 'x-step-up-token': token })).status, 200);
    assert.equal((await request('/oidc/link', { callbackURL: 'http://localhost:5173/settings' }, cookie, { 'x-step-up-token': token })).status, 403);
  });
  test('link callback rejects different email and an expired initiating session', async () => {
    for (const invalidate of ['email', 'expired', 'replaced']) {
      const local = uniqueProfile();
      const signup = await request('/sign-up/email', { email: local.email, name: 'Link fixture', password: 'local-test-password' });
      const cookie = cookies(signup), current = await session(cookie);
      await db.user.update({ where: { id: current.user.id }, data: { emailVerified: true } });
      const token = await issueStepUp(current.user.id, current.session.token, 'account');
      const flow = await start(invalidate === 'email' ? uniqueProfile() : local, '', cookie, token);
      if (invalidate === 'expired') await authRedis.del(current.session.token);
      if (invalidate === 'replaced') {
        const replaced = await request('/sign-in/email', { email: local.email, password: 'local-test-password' });
        flow.cookie = cookies(replaced, flow.cookie);
      }
      assert.equal((await callback(flow)).headers.get('location'), 'http://localhost:5173/settings?tab=security&oidc_error=1');
      assert.equal(await db.account.count({ where: { userId: current.user.id, providerId: settings.providerId } }), 0);
    }
  });
  test('local disable and durable epoch revocation remain effective for OIDC sessions', async () => {
    const profile = uniqueProfile(), logged = await login(profile);
    await db.user.update({ where: { id: logged.current.user.id }, data: { sessionEpoch: { increment: 1 } } });
    assert.equal(await session(logged.cookie), null);
    const fresh = await login(profile);
    await db.user.update({ where: { id: fresh.current.user.id }, data: { status: 'DISABLED', sessionEpoch: { increment: 1 } } });
    assert.equal(await session(fresh.cookie), null);
    assert.equal((await callback(await start(profile))).headers.get('location'), 'http://localhost:5173/login?oidc_error=1');
  });
  test('enrolled local MFA challenges are required after OIDC and complete through the existing recovery-code route', async () => {
    const profile = uniqueProfile(), logged = await login(profile);
    const { symmetricEncrypt } = require('better-auth/crypto');
    const context = await auth.$context;
    const recovery = 'oidc-recovery-fixture-code';
    await db.twoFactor.create({ data: {
      userId: logged.current.user.id, verified: true,
      secret: await symmetricEncrypt({ key: context.secretConfig, data: 'JBSWY3DPEHPK3PXP' }),
      backupCodes: await symmetricEncrypt({ key: context.secretConfig, data: JSON.stringify([recovery]) }),
    } });
    await db.user.update({ where: { id: logged.current.user.id }, data: { twoFactorEnabled: true } });
    const flow = await start(profile), challenge = await callback(flow);
    assert.equal(challenge.headers.get('location'), 'http://localhost:5173/login?oidc_mfa=1');
    const cookie = cookies(challenge, flow.cookie);
    assert.equal(await session(cookie), null);
    const verified = await request('/two-factor/verify-backup-code', { code: recovery }, cookie);
    assert.equal(verified.status, 200, await verified.clone().text());
    assert.equal((await session(cookies(verified, cookie))).user.id, logged.current.user.id);
  });
  test('email domains and provisioning policy reject unauthorized identities; concurrent provisioning is unique', async () => {
    const blocked = new OidcClient({ ...settings, emailDomains: ['other.test'] });
    const flow = await start(uniqueProfile()), params = new URL(flow.url).searchParams;
    const raw = await (await auth.$context).internalAdapter.findVerificationValue(params.get('state'));
    const state = JSON.parse(raw.value);
    await assert.rejects(() => blocked.profile(new URL(flow.callback), params.get('state'), state.codeVerifier, state.oidcNonce));
    const profile = uniqueProfile(), identity = { subject: profile.sub, email: profile.email, name: profile.name };
    await assert.rejects(() => resolveOidcIdentity(db, { ...settings, autoProvision: false }, identity));
    const identities = await Promise.all([resolveOidcIdentity(db, settings, identity), resolveOidcIdentity(db, settings, identity)]);
    assert.equal(identities[0].id, identities[1].id);
    assert.equal(await db.account.count({ where: { providerId: settings.providerId, accountId: profile.sub } }), 1);
  });
  test('discovery/token network failures fail closed without exposing provider errors', async () => {
    const client = new OidcClient({ ...settings, issuer: 'http://127.0.0.1:1/' });
    await assert.rejects(() => client.authorizationURL('state', 'verifier', 'nonce'), /OIDC_DISCOVERY_FAILED/);
  });
}
