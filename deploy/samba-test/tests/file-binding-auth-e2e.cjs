// A file binding must never switch local login authority or inherit admin roles.
// Only generated qa_* objects in the isolated ASSAY.TEST domain are changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const suffix = Date.now().toString().slice(-8);
const fixture = { adName: 'qa_auth_' + suffix, email: 'qa-auth-' + suffix + '@assay.test', adPassword: 'Aa9!' + randomBytes(20).toString('base64url'), localPassword: 'Aa9!' + randomBytes(20).toString('base64url') };
const secrets = [adminPassword, fixture.adPassword, fixture.localPassword];
const results = []; let browser;
const save = () => fs.writeFileSync(dir + '/file-binding-auth-fixture.json', JSON.stringify(fixture, null, 2), { mode: 0o600 });
const pass = name => { results.push(name); console.log('PASS ' + name); };
async function api(context, path, method = 'GET', data, expected = 200) {
  const response = await context.request.fetch(origin + '/api' + path, { method, headers: { Origin: origin }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), expected, 'Unexpected status for ' + path);
  return response.status() === 204 ? undefined : response.json();
}
async function command(admin, action, args) {
  const id = randomUUID(); await api(admin, '/samba/commands', 'POST', { requestId: id, action, args }, 201);
  for (let i = 0; i < 100; i++) {
    const result = await api(admin, '/samba/operations/' + id);
    if (result.state === 'succeeded') return;
    assert(['queued', 'pending', 'running'].includes(result.state), 'QA command failed');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('QA command timed out');
}
(async () => {
  save(); browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',localhost,127.0.0.1' } } : {}) });
  const context = () => browser.newContext({ ignoreHTTPSErrors: true });
  const admin = await context();
  await api(admin, '/auth/sign-in/email', 'POST', { email: 'admin@assay.test', password: adminPassword });
  const original = await api(admin, '/me'); assert(original.roles.includes('admin')); assert.equal(original.passwordSource, 'local');
  const snapshot = await api(admin, '/samba/snapshot'); assert.equal(snapshot.domain.toLowerCase(), 'dc=assay,dc=test');
  const originalBindings = snapshot.bindings.filter(b => b.userId === original.id);
  pass('The independent local administrator signs in with the original password');

  await command(admin, 'user.create', { name: fixture.adName, display_name: 'QA file binding identity boundary', password: fixture.adPassword });
  const ad = (await api(admin, '/samba/snapshot')).users.find(u => u.name === fixture.adName); assert(ad);
  fixture.adId = ad.id;
  const local = await api(admin, '/users', 'POST', { email: fixture.email, name: 'QA local administrator identity boundary', password: fixture.localPassword, roleNames: ['admin'] }, 201);
  fixture.userId = local.id; save();
  await api(admin, '/samba/bindings', 'POST', { userId: local.id, adObjectId: ad.id }, 201);
  const localContext = await context(); await api(localContext, '/auth/sign-in/email', 'POST', { email: fixture.email, password: fixture.localPassword });
  const before = await api(localContext, '/me'); assert.equal(before.id, local.id); assert.equal(before.passwordSource, 'local');
  pass('A file binding keeps the linked administrator local and preserves its credential');

  const company = await context();
  const rejected = await api(company, '/auth/sign-in/directory', 'POST', { username: fixture.adName, password: fixture.adPassword }, 403);
  assert.equal(rejected.code, 'DIRECTORY_LINK_REQUIRED'); await api(company, '/me', 'GET', undefined, 401);
  assert.equal((await api(localContext, '/me')).passwordSource, 'local');
  assert.equal((await api(admin, '/users')).find(u => u.id === local.id).directoryAccount, null);
  pass('Knowing the linked AD password cannot claim the administrator or disable its local login');

  const page = await company.newPage(); await page.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
  await page.goto(origin + '/login'); await page.getByRole('button', { name: '公司账号', exact: true }).click();
  await page.locator('form input').first().fill(fixture.adName); await page.locator('input[type=password]').fill(fixture.adPassword); await page.locator('form button[type=submit]').click();
  await page.getByText('此公司账号已有文件访问关联。请联系管理员在“身份与访问”中明确配置登录身份关联；文件关联不会自动切换本地账号的登录方式。', { exact: true }).waitFor();
  assert.equal((await api(localContext, '/me')).id, local.id);
  pass('The company login page explains the required association instead of reporting a bad password');

  await api(admin, '/directory/identities', 'POST', { userId: local.id, username: fixture.adName }, 201);
  await api(company, '/auth/sign-in/directory', 'POST', { username: fixture.adName, password: fixture.adPassword });
  const linked = await api(company, '/me'); assert.equal(linked.id, local.id); assert.equal(linked.passwordSource, 'directory');
  await api(localContext, '/me', 'GET', undefined, 401);
  await api(localContext, '/auth/sign-in/email', 'POST', { email: fixture.email, password: fixture.localPassword }, 401);
  pass('Only explicit platform association changes login authority, preserving the business ID and revoking old local sessions');

  const final = await api(admin, '/me'); assert.equal(final.id, original.id); assert.equal(final.passwordSource, 'local'); assert(final.roles.includes('admin'));
  assert.deepEqual((await api(admin, '/samba/snapshot')).bindings.filter(b => b.userId === original.id), originalBindings);
  await api(admin, '/users/' + local.id, 'PATCH', { status: 'DISABLED', roleNames: ['requester'] });
  await command(admin, 'user.update', { id: ad.id, display_name: 'QA file binding identity boundary', disabled: true });
  pass('The original emergency administrator is unaffected; the generated privileged test principal is disabled');
  fs.writeFileSync(dir + '/file-binding-auth-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => { let message = error.message; for (const secret of secrets) message = message.replaceAll(secret, '[redacted]'); console.error(message); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
