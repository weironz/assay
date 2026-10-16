// Real AD + SMB regression. Only the isolated ASSAY.TEST stack and generated qa_* users.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const origin = require('./test-origin.cjs');
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const fixture = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const password = 'Aa9!' + randomBytes(24).toString('base64url');
const secrets = [adminPassword, fixture.ad_password, fixture.assay_password, password];
const results = [], signIns = [];
let browser;
const pass = name => { results.push(name); console.log('PASS ' + name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function checked(response, status = 200) { assert.equal(response.status(), status, 'Unexpected response status'); return response; }
async function api(page, method, path, data, headers = {}, status = 200) {
  const send = () => page.request.fetch(origin + '/api' + path, { method, data, headers: { Origin: origin, ...headers } });
  let r = await send();
  if (r.status() === 429 && path.startsWith('/auth/sign-in/')) { await sleep(61000); r = await send(); }
  await checked(r, status); return r.json();
}
async function stepUp(page, purpose = 'samba', credential = adminPassword) {
  return (await api(page, 'POST', '/me/security/step-up', { purpose, password: credential }, {}, 201)).stepUpToken;
}
async function command(page, action, args) {
  const requestId = randomUUID();
  await api(page, 'POST', '/samba/commands', { requestId, action, args }, { 'x-step-up-token': await stepUp(page) }, 201);
  for (let i = 0; i < 100; i++) {
    const op = await api(page, 'GET', '/samba/operations/' + requestId);
    if (op.state === 'succeeded') return;
    if (!['pending', 'queued', 'running'].includes(op.state)) throw new Error('QA directory command did not succeed');
    await sleep(100);
  }
  throw new Error('QA directory command timed out');
}
async function localLogin(page, email, credential) {
  await page.goto(origin + '/login');

  await page.locator('form input').first().fill(email);
  await page.locator('input[type=password]').fill(credential);
  await page.locator('button[type=submit]').click(); await page.waitForURL('**/dashboard');
}
async function directoryLogin(page, username, credential, code) {
  // Respect the production login rate limit even during regression tests.
  while (signIns.length && Date.now() - signIns[0] > 61000) signIns.shift();
  if (signIns.length >= 4) { await sleep(61000 - (Date.now() - signIns[0])); signIns.shift(); }
  signIns.push(Date.now());
  return api(page, 'POST', '/auth/sign-in/directory', { username, password: credential, ...(code ? { code } : {}) });
}
function totp(uri) {
  const encoded = new URL(uri).searchParams.get('secret');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of encoded.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const raw = Buffer.from((bits.match(/.{8}/g) || []).map(s => parseInt(s, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', raw).update(counter).digest(); const offset = h[19] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: `${new URL(origin).hostname},127.0.0.1,localhost` } } : {}) });
  const context = async () => {
    const c = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    await c.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
    return c;
  };
  const adminContext = await context(), admin = await adminContext.newPage();
  await localLogin(admin, 'admin@assay.test', adminPassword);
  const original = await api(admin, 'GET', '/samba/snapshot');
  assert.equal(original.domain.toLowerCase(), 'dc=assay,dc=test', 'Refuse a non-isolated domain');
  const adminMe = await api(admin, 'GET', '/me');
  const originalBinding = original.bindings.filter(b => b.userId === adminMe.id);
  assert(adminMe.roles.includes('admin')); assert.equal(adminMe.passwordSource, 'local');
  pass('Local emergency administrator still signs in with the original business ID and permissions');
  const nav = admin.getByRole('navigation', { name: '业务模块', exact: true });
  await nav.getByRole('link', { name: '文件管理', exact: true }).waitFor();
  const labels = await nav.getByRole('link').allTextContents();
  assert.equal(labels.at(-1).trim(), '文件管理');
  assert(!labels.some(s => s.includes('公司目录与文件') || s.includes('我的文件')));
  await admin.goto(origin + '/samba/users/' + fixture.user_id);
  await admin.getByRole('link', { name: '共享文件', exact: true }).waitFor();
  pass('One file-management menu follows other modules and legacy management deep links retain its sidebar');

  const suffix = String(Date.now()).slice(-8), name = 'qa_sso_' + suffix;
  const groupName = original.groupPrefix + 'qa_sso_group_' + suffix, share = 'qa_sso_' + suffix;
  await command(admin, 'user.create', { name, display_name: 'QA unified company identity', password, profile: { email: name + '@assay.test' } });
  await command(admin, 'group.create', { name: groupName, description: 'QA unified login role and share group' });
  let snapshot = await api(admin, 'GET', '/samba/snapshot');
  const employee = snapshot.users.find(u => u.name === name), group = snapshot.groups.find(g => g.name === groupName);
  assert(employee && group && name.startsWith('qa_'));
  await command(admin, 'group.member', { group_id: group.id, user_id: employee.id, add: true });
  await command(admin, 'share.save', { name: share, comment: 'QA unified identity files', groups: [group.id], read_only: false });
  fs.writeFileSync(dir + '/directory-fixture.json', JSON.stringify({ name, password, employeeId: employee.id, groupId: group.id, share }), { mode: 0o600 });
  const employeeContext = await context(), page = await employeeContext.newPage();
  let fileChallenges = 0;
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/files/session') fileChallenges++; });
  await page.goto(origin + '/login'); await page.getByLabel('账号', { exact: true }).waitFor();
  await page.locator('form input').first().fill(name); await page.locator('input[type=password]').fill(password);
  signIns.push(Date.now()); await page.locator('button[type=submit]').click(); await page.waitForURL('**/dashboard');
  await page.getByRole('link', { name: '打开共享目录：' + share, exact: true }).waitFor();
  const employeeMe = await api(page, 'GET', '/me');
  assert.equal(employeeMe.passwordSource, 'directory'); assert.deepEqual(employeeMe.roles, []);
  const files = await api(page, 'GET', '/files/status'); assert(files.connected && files.shares.includes(share));
  assert.equal(fileChallenges, 0); assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.equal(await page.getByRole('link', { name: '员工账号', exact: true }).count(), 0);
  pass('First AD login automatically creates one employee identity and opens workspace folder shortcuts without another password prompt');
  await page.screenshot({ path: dir + '/directory-login-workspace.png', fullPage: true });
  await api(page, 'POST', '/files/commands', { action: 'mkdir', share, path: 'from-company-login' }, {}, 201);
  const content = 'own AD SMB connection ' + randomUUID();
  await checked(await page.request.put(origin + '/api/files/content?' + new URLSearchParams({ share, path: 'from-company-login/proof.txt' }), { headers: { Origin: origin, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(content) }));
  const download = await checked(await page.request.get(origin + '/api/files/content?' + new URLSearchParams({ share, path: 'from-company-login/proof.txt' })));
  assert.equal(await download.text(), content);
  await api(page, 'POST', '/files/commands', { action: 'move', share, path: 'from-company-login/proof.txt', destination: 'from-company-login/moved.txt' }, {}, 201);
  await api(page, 'POST', '/files/commands', { action: 'delete', share, path: 'from-company-login/moved.txt' }, {}, 201);
  await api(page, 'POST', '/files/commands', { action: 'delete', share, path: 'from-company-login' }, {}, 201);
  pass('Upload, download, move and delete use the employee SMB connection established at sign-in');
  await api(page, 'POST', '/me/security/step-up', { purpose: 'api-tokens', password }, {}, 201);
  pass('Pure AD accounts use their company password for sensitive-operation verification');
  await page.goto(origin + '/settings?tab=security');
  await page.getByText('登录密码由公司 AD 管理，无需设置另一份 Assay 密码。修改公司密码后请重新登录。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '修改密码', exact: true }).count(), 0);
  const rejectedLocal = await admin.request.post(origin + '/api/users/' + employeeMe.id + '/reset-password', { headers: { Origin: origin, 'x-step-up-token': await stepUp(admin, 'roles') }, data: { newPassword: 'This-is-not-created-9!' } });
  await checked(rejectedLocal, 400);
  pass('Pure AD accounts expose company password settings and reject accidental creation of local credentials');

  await admin.goto(origin + '/directory-settings');
  await admin.getByLabel('AD 用户组', { exact: true }).selectOption(group.sid);
  await admin.getByLabel('Assay 业务角色', { exact: true }).selectOption('inventory_manager');
  let mutation = admin.waitForResponse(r => r.url().endsWith('/api/directory/mappings') && r.request().method() === 'POST');
  await admin.getByRole('button', { name: '添加映射', exact: true }).click();
  await checked(await mutation, 201); await admin.locator('[data-admin-action]').waitFor({ state: 'detached' });
  assert((await api(page, 'GET', '/me')).roles.includes('inventory_manager'));
  await api(page, 'GET', '/inventory/balances');
  pass('An AD group mapped through the Web UI grants real inventory API access');
  mutation = admin.waitForResponse(r => r.url().endsWith('/api/directory/mappings') && r.request().method() === 'DELETE');
  await admin.getByRole('button', { name: '移除映射', exact: true }).click();
  await checked(await mutation); await admin.locator('[data-admin-action]').waitFor({ state: 'detached' });
  assert(!(await api(page, 'GET', '/me')).roles.includes('inventory_manager'));
  await checked(await page.request.get(origin + '/api/inventory/balances'), 403);
  pass('Removing the mapping withdraws inventory permissions from the existing session immediately');

  const linkedName = 'qa_link_' + suffix, linkPassword = 'Aa9!' + randomBytes(24).toString('base64url');
  const localPassword = 'Aa9!' + randomBytes(24).toString('base64url'); secrets.push(linkPassword, localPassword);
  await command(admin, 'user.create', { name: linkedName, display_name: 'QA existing business account link', password: linkPassword });
  const businessUser = await api(admin, 'POST', '/users', { email: linkedName + '@assay.test', name: 'QA existing business account link', password: localPassword, roleNames: ['requester'] }, { 'x-step-up-token': await stepUp(admin, 'roles') }, 201);
  const oldLocalContext = await context(), oldLocalPage = await oldLocalContext.newPage();
  await api(oldLocalPage, 'POST', '/auth/sign-in/email', { email: linkedName + '@assay.test', password: localPassword });
  await admin.reload();
  await admin.getByLabel('现有业务账号', { exact: true }).selectOption(businessUser.id);
  await admin.getByLabel('公司账号', { exact: true }).fill(linkedName);
  mutation = admin.waitForResponse(r => r.url().endsWith('/api/directory/identities') && r.request().method() === 'POST');
  await admin.getByRole('button', { name: '关联现有账号', exact: true }).click();
  await checked(await mutation, 201); await admin.locator('[data-admin-action]').waitFor({ state: 'detached' });
  const linkedContext = await context(), linkedPage = await linkedContext.newPage();
  await directoryLogin(linkedPage, linkedName, linkPassword);
  const linkedMe = await api(linkedPage, 'GET', '/me'); assert.equal(linkedMe.id, businessUser.id); assert.equal(linkedMe.passwordSource, 'directory');
  await checked(await oldLocalPage.request.get(origin + '/api/me'), 401);
  await api(oldLocalPage, 'POST', '/auth/sign-in/email', { email: linkedName + '@assay.test', password: localPassword }, {}, 401);
  const legacySetup = await api(linkedPage, 'POST', '/auth/two-factor/enable', { password: linkPassword });
  secrets.push(...legacySetup.backupCodes);
  await api(linkedPage, 'POST', '/auth/two-factor/verify-totp', { code: totp(legacySetup.totpURI) });
  await api(linkedPage, 'POST', '/me/security/step-up', { purpose: 'account', password: linkPassword, code: totp(legacySetup.totpURI) }, {}, 201);
  await api(linkedPage, 'POST', '/auth/sign-out', {});
  pass('The platform identity page explicitly links an existing business principal through LDAP without a Samba binding operation');
  pass('Linked employees use only AD authentication and MFA; old local sessions and retained local passwords cannot bypass the directory');

  const existingContext = await context(), existing = await existingContext.newPage();
  await api(existing, 'POST', '/auth/sign-in/email', { email: fixture.assay_email, password: fixture.assay_password });
  const oldMe = await api(existing, 'GET', '/me'); assert.equal(oldMe.id, fixture.assay_user_id);
  const ticket = await api(existing, 'POST', '/tickets', { title: 'QA existing identity retention ' + suffix, body: '<p>Keep requester and original business ID during optional AD login.</p>' }, {}, 201);
  await api(existing, 'POST', '/auth/sign-out', {});
  await api(admin, 'POST', '/directory/identities', { userId: oldMe.id, username: fixture.ad_name }, { 'x-step-up-token': await stepUp(admin, 'roles') }, 201);
  await directoryLogin(existing, fixture.ad_name, fixture.ad_password);
  assert.equal((await api(existing, 'GET', '/me')).id, oldMe.id);
  assert.equal((await api(existing, 'GET', '/tickets/' + ticket.id)).requesterId, oldMe.id);
  await api(existing, 'POST', '/auth/sign-out', {});
  pass('An explicitly linked existing employee retains the same user ID and ownership of an existing ticket');

  const setup = await api(page, 'POST', '/auth/two-factor/enable', { password });
  assert(setup.totpURI && setup.backupCodes?.length); secrets.push(...setup.backupCodes);
  await api(page, 'POST', '/auth/two-factor/verify-totp', { code: totp(setup.totpURI) });
  assert((await api(page, 'GET', '/me')).twoFactorEnabled);
  await api(page, 'POST', '/auth/sign-out', {});
  const pending = await directoryLogin(page, name, password); assert.equal(pending.twoFactorRequired, true);
  await checked(await page.request.get(origin + '/api/me'), 401);
  const done = await directoryLogin(page, name, password, totp(setup.totpURI)); assert(done.filesConnected);
  assert.equal((await api(page, 'GET', '/me')).id, employeeMe.id);
  pass('AD-only employees enroll TOTP without a local password; AD sign-in issues no session before MFA succeeds');
  await api(page, 'POST', '/auth/sign-out', {});
  const backed = await directoryLogin(page, name, password, setup.backupCodes[0]); assert(backed.filesConnected);
  const replayContext = await context(), replay = await replayContext.newPage();
  while (signIns.length && Date.now() - signIns[0] > 61000) signIns.shift();
  if (signIns.length >= 4) await sleep(61000 - (Date.now() - signIns[0]));
  await checked(await replay.request.post(origin + '/api/auth/sign-in/directory', { headers: { Origin: origin }, data: { username: name, password, code: setup.backupCodes[0] } }), 401);
  pass('AD sign-in consumes existing encrypted MFA backup codes only once');
  await command(admin, 'user.update', { id: employee.id, display_name: 'QA unified company identity', disabled: true });
  const blockedFiles = await page.request.get(origin + '/api/files/list?' + new URLSearchParams({ share, path: '' }));
  assert([401, 403].includes(blockedFiles.status()));
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) { if ((await page.request.get(origin + '/api/me')).status() === 401) break; await sleep(2000); }
  await checked(await page.request.get(origin + '/api/me'), 401);
  pass('Disabling the AD employee blocks file access and revokes business authorization within the documented cache bound');
  const final = await api(admin, 'GET', '/samba/snapshot');
  assert.deepEqual(final.bindings.filter(b => b.userId === adminMe.id), originalBinding);
  assert.equal((await api(admin, 'GET', '/me')).id, adminMe.id);
  pass('Local emergency access and the user-created administrator AD association remain intact');
  await api(admin, 'POST', '/auth/sign-out', {});
  fs.writeFileSync(dir + '/directory-auth-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => {
  let message = error.message || 'Regression failed';
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
