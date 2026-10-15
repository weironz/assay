// Run inside the isolated API container against a separate disposable gateway
// configured with idle_seconds=2, lifetime_seconds=3. Read QA identity/password
// and managed shares from stdin; never log or persist authentication material.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const origin = process.env.SAMBA_E2E_GATEWAY_URL;
const token = fs.readFileSync(process.env.FILES_GATEWAY_TOKEN_FILE, 'utf8').trim();
const results = [], active = [];
let input;
const pass = name => { results.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, session, method = 'GET', body, ttl, status = 200) {
  const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + token,
    ...(session ? { 'X-File-Owner': session.owner, 'X-File-Session': session.token } : {}),
    ...(ttl === undefined ? {} : { 'X-File-TTL': String(ttl) }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, status, 'Gateway response mismatch'); return response.json();
}
async function login(follow, ttl) {
  const owner = randomBytes(32).toString('hex');
  const data = await request('/v1/session', null, 'POST', { owner, identity: input.identity, shares: input.shares, password: input.password, ttl, follow_web_session: follow });
  const session = { owner, token: data.token }; active.push(session); return { ...session, ...data };
}
(async () => {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  input = JSON.parse(raw); raw = '';
  assert(input.identity.name.startsWith('qa_')); assert(origin?.startsWith('http://assay-file-lease-probe:'));
  const web = await login(true, 180); const legacy = await login(false, 180);
  assert(web.followsWebSession); assert(web.expiresAt - Math.floor(Date.now() / 1000) > 170);
  assert(legacy.expiresAt - Math.floor(Date.now() / 1000) <= 3);
  await delay(5000);
  await request('/v1/session', legacy, 'GET', undefined, undefined, 410);
  assert((await request('/v1/session', web)).followsWebSession);
  pass('The Web connection survives accelerated idle/absolute limits while legacy connections still expire');

  const shortened = await request('/v1/session', web, 'GET', undefined, 20);
  assert(shortened.expiresAt - Math.floor(Date.now() / 1000) <= 20);
  const renewed = await request('/v1/session', web, 'GET', undefined, 180);
  assert(renewed.expiresAt > shortened.expiresAt + 140);
  for (const ttl of [0, -1, 'bad', 604801]) await request('/v1/session', web, 'GET', undefined, ttl, 400);
  assert((await request('/v1/session', web)).expiresAt === renewed.expiresAt);
  pass('A bound valid request can shorten/extend a live lease; invalid renewal deadlines are rejected');

  await request('/v1/session', { ...web, owner: randomBytes(32).toString('hex') }, 'GET', undefined, 180, 410);
  const anonymous = await fetch(origin + '/v1/session', { headers: { 'X-File-Owner': web.owner, 'X-File-Session': web.token, 'X-File-TTL': '180' } });
  assert.equal(anonymous.status, 401); await request('/v1/session', web);
  pass('Another owner and an unauthenticated caller cannot use or renew a live connection');

  const short = await login(true, 2); await delay(3000);
  await request('/v1/session', short, 'GET', undefined, 180, 410);
  pass('An expired Web owner lease cannot be revived by sending a later deadline');

  // No browser heartbeat or further password authentication occurs during this
  // idle period. The real LDAP/SMB maintenance probe runs after sixty seconds.
  await delay(95000);
  const afterIdle = await request('/v1/session', web);
  assert.equal(afterIdle.expiresAt, renewed.expiresAt, 'Maintenance must not extend the owner lease');
  await request('/v1/list?' + new URLSearchParams({ share: input.shares[0], path: '' }), web);
  pass('The same LDAP/SMB connection remains usable after an idle maintenance cycle without renewing its owner lease');

  await request('/v1/session', web, 'DELETE'); await request('/v1/session', web, 'GET', undefined, 180, 410);
  pass('Explicit disconnect closes the connection and future renewal cannot recreate it');
  console.log(JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }));
})().catch(error => {
  let message = error.message; for (const secret of [token, input?.password, ...active.map(s => s.token)]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}).finally(async () => { if (input) input.password = ''; for (const session of active) await request('/v1/session', session, 'DELETE').catch(() => {}); });
