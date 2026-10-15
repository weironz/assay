// Real employee SMB/ACL tests. Requires the private fixture from web-e2e.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { chromium } = require('playwright');
const https = require('node:https');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const fixture = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const results = [];
let browser;
function pass(name) { results.push(name); console.log('PASS ' + name); }
async function login(page, email, password) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
  await page.goto(origin + '/login'); await page.locator('form input').first().fill(email);
  await page.locator('input[type=password]').fill(password); await page.locator('form button[type=submit]').click(); await page.waitForURL('**/dashboard');
}
function endpoint(path, share, file = '') { return origin + '/api/files/' + path + '?' + new URLSearchParams({ share, path: file }); }
async function checked(response, code) { assert.equal(response.status(), code, `HTTP ${response.status()}: ${(await response.text()).slice(0, 200)}`); return response; }
const headers = { Origin: origin };
async function adLogin(page) { return checked(await page.request.post(origin + '/api/files/session', { headers, data: { password: fixture.ad_password } }), 201); }
async function stepUp(page) { const r = await checked(await page.request.post(origin + '/api/me/security/step-up', { headers, data: { purpose: 'samba', password: adminPassword } }), 201); return (await r.json()).stepUpToken; }
async function adminCommand(page, action, args) {
  const requestId = randomUUID();
  await checked(await page.request.post(origin + '/api/samba/commands', { headers: { ...headers, 'x-step-up-token': await stepUp(page) }, data: { requestId, action, args } }), 201);
  for (let i = 0; i < 200; i++) {
    const r = await checked(await page.request.get(origin + '/api/samba/operations/' + requestId), 200); const op = await r.json();
    if (!['pending', 'queued', 'running'].includes(op.state)) { assert.equal(op.state, 'succeeded', action); return; }
    await page.waitForTimeout(100);
  }
  throw new Error('Test management operation timed out');
}
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: `${new URL(origin).hostname},127.0.0.1,localhost` } } : {}) });
  const ac = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const admin = await ac.newPage();
  await checked(await admin.request.get(origin + '/api/files/status'), 401); pass('Anonymous file access is denied');
  await login(admin, 'admin@assay.test', adminPassword);
  assert.equal((await (await admin.request.get(origin + '/api/files/status')).json()).identity, null);
  await admin.goto(origin + '/platform'); await admin.getByRole('heading', { name: '管理概览', exact: true }).waitFor();
  assert.equal(await admin.locator('main').getByRole('link', { name: /员工账号/ }).count(), 0);
  await admin.locator('header').getByRole('link', { name: '公司目录与文件', exact: true }).first().click();
  await admin.getByRole('heading', { name: '管理概览', exact: true }).waitFor(); pass('Company directory is a top-level module; platform management contains only Assay access settings');
  const suffix = Date.now().toString().slice(-7); const readonly = 'portal_ro_' + suffix; const denied = 'portal_no_' + suffix;
  const deniedGroup = 'portal_group_' + suffix;
  await adminCommand(admin, 'group.create', { name: deniedGroup, description: '员工文件拒绝测试组' });
  const deniedGroupId = (await (await checked(await admin.request.get(origin + '/api/samba/snapshot'), 200)).json()).groups.find(g => g.name === deniedGroup).id;
  await adminCommand(admin, 'share.save', { name: readonly, comment: '员工文件只读测试', groups: [fixture.group_id], read_only: true });
  await adminCommand(admin, 'share.save', { name: denied, comment: '员工文件拒绝测试', groups: [deniedGroupId], read_only: false });
  const ec = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); const employee = await ec.newPage();
  await login(employee, fixture.assay_email, fixture.assay_password);
  await employee.locator('header').getByRole('link', { name: '我的文件', exact: true }).first().click();
  await employee.getByRole('heading', { name: '验证自己的 AD 密码', exact: true }).waitFor();
  assert.equal(await employee.locator('header').getByRole('link', { name: '公司目录与文件', exact: true }).count(), 0);
  await checked(await employee.request.get(origin + '/api/samba/snapshot'), 403); pass('Employee sees optional file entry without receiving directory management permissions');
  const initial = await (await checked(await employee.request.get(origin + '/api/files/status'), 200)).json();
  assert.equal(initial.connected, false); assert.equal(initial.identity.accountName, fixture.ad_name);
  await checked(await employee.request.post(origin + '/api/files/session', { headers, data: { password: fixture.ad_password, username: 'Administrator' } }), 400);
  await checked(await employee.request.post(origin + '/api/files/session', { headers, data: { password: 'DefinitelyWrongPassword9!' } }), 403);
  await checked(await employee.request.post(origin + '/api/files/session', { headers: { Origin: 'https://attacker.invalid' }, data: { password: fixture.ad_password } }), 403);
  pass('Caller cannot select a different AD identity; wrong passwords and cross-origin writes are rejected');
  await employee.getByLabel('AD 密码', { exact: true }).fill(fixture.ad_password);
  await employee.getByRole('button', { name: '验证并打开文件', exact: true }).click();
  await employee.getByLabel('共享目录', { exact: true }).waitFor();
  const status = await (await checked(await employee.request.get(origin + '/api/files/status'), 200)).json();
  assert.equal(status.connected, true); assert.equal(status.token, undefined); assert(status.shares.includes(fixture.share)); assert(status.shares.includes(readonly)); assert(!status.shares.includes(denied));
  assert.equal(await employee.getByLabel('AD 密码', { exact: true }).count(), 0); pass('Own LDAP identity and encrypted SMB session unlock only readable managed shares; no gateway token reaches browser');
  await employee.getByLabel('共享目录', { exact: true }).selectOption(fixture.share);
  const uiName = 'portal-ui-' + suffix + '.txt'; const uiBytes = Buffer.from('员工浏览器上传下载验证\n');
  await employee.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: uiName, mimeType: 'application/octet-stream', buffer: uiBytes });
  await employee.getByText('已上传 ' + uiName, { exact: true }).waitFor();
  const uiRow = employee.getByRole('table', { name: '文件', exact: true }).getByRole('row').filter({ hasText: uiName });
  const downloadEvent = employee.waitForEvent('download'); await uiRow.getByRole('link', { name: '下载', exact: true }).click();
  const uiDownload = await downloadEvent; assert.deepEqual(fs.readFileSync(await uiDownload.path()), uiBytes);
  await uiRow.getByRole('button', { name: '删除', exact: true }).click();
  await employee.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click(); await uiRow.waitFor({ state: 'hidden' });
  pass('Actual Web upload, browser download and delete controls transfer employee data correctly');
  await checked(await employee.request.get(endpoint('list', readonly)), 200);
  await checked(await employee.request.put(endpoint('content', readonly, 'not-allowed.txt'), { headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: Buffer.from('no') }), 403);
  pass('Read-only share can be browsed but Samba denies employee writes');
  const root = '员工文件测试-' + suffix; const name = '年度报告-中文.bin'; const path = root + '/' + name;
  const command = data => employee.request.post(origin + '/api/files/commands', { headers, data: { share: fixture.share, ...data } });
  await checked(await command({ action: 'mkdir', path: root }), 201);
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const put = (file, data) => employee.request.put(endpoint('content', fixture.share, file), { headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data });
  await checked(await put(path, bytes), 200);
  await checked(await put(path, Buffer.from('must not replace original')), 409);
  const download = await checked(await employee.request.get(endpoint('content', fixture.share, path)), 200);
  assert.equal(createHash('sha256').update(await download.body()).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  assert(download.headers()['content-disposition'].includes("filename*=UTF-8''"));
  pass('Streamed multi-megabyte Unicode file round-trips exactly; duplicate upload preserves original content');
  await checked(await put(root + '/empty.txt', Buffer.alloc(0)), 200);
  if (process.env.SAMBA_E2E_CA_FILE) {
    const cookies = (await ec.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
    await new Promise(resolve => {
      const request = https.request(endpoint('content', fixture.share, root + '/incomplete.bin'), { method: 'PUT', ca: fs.readFileSync(process.env.SAMBA_E2E_CA_FILE), headers: { ...headers, Cookie: cookies, 'Content-Type': 'application/octet-stream', 'Content-Length': 20 * 1024 * 1024 } });
      request.on('error', () => resolve()); request.write(Buffer.alloc(65536)); setTimeout(() => request.destroy(), 500);
    });
    await employee.waitForTimeout(1500);
    const afterCancel = await (await checked(await employee.request.get(endpoint('list', fixture.share, root)), 200)).json();
    assert(!afterCancel.entries.some(e => e.name === 'incomplete.bin'));
    pass('Interrupted streaming upload does not publish an incomplete business file');
  }
  const listed = await (await checked(await employee.request.get(endpoint('list', fixture.share, root)), 200)).json();
  assert.equal(listed.entries.length, 2); assert(!listed.entries.some(e => e.name.startsWith('.assay-upload-')));
  await checked(await command({ action: 'delete', path: root }), 409); pass('Zero-byte uploads work; nonempty directories cannot be recursively deleted');
  await checked(await command({ action: 'move', path, destination: root + '/重命名.bin' }), 201);
  await checked(await employee.request.get(endpoint('content', fixture.share, path)), 404);
  await checked(await command({ action: 'delete', path: root + '/重命名.bin' }), 201);
  await checked(await command({ action: 'delete', path: root + '/empty.txt' }), 201);
  await checked(await command({ action: 'delete', path: root }), 201); pass('Employee can move, rename, delete files and delete an empty folder through own SMB ACL');
  for (const path of ['../private', '/etc/passwd', 'x:ads', 'x\\y', '.assay-upload-hidden']) await checked(await employee.request.get(endpoint('list', fixture.share, path)), 400);
  pass('Traversal, UNC, alternate streams and staging-name access are rejected');
  await checked(await employee.request.get(endpoint('list', denied)), 403); pass('A different group share is denied with no administrator fallback');
  await employee.setViewportSize({ width: 390, height: 844 }); await employee.reload();
  await employee.getByLabel('共享目录', { exact: true }).selectOption(fixture.share);
  await employee.getByRole('table', { name: '文件', exact: true }).getByText(/probe.txt/).waitFor();
  assert.equal(await employee.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const shortName = await employee.getByRole('table', { name: '文件', exact: true }).getByRole('button').filter({ hasText: 'probe.txt' }).boundingBox();
  assert(shortName && shortName.height <= 52, 'Short filenames remain readable on mobile');
  await employee.screenshot({ path: dir + '/employee-files-mobile.png', fullPage: true }); pass('File browser fits a 390px mobile viewport');
  await checked(await employee.request.delete(origin + '/api/files/session', { headers }), 200);
  await checked(await employee.request.get(endpoint('list', fixture.share)), 410);
  await adLogin(employee); pass('Explicit disconnect invalidates the SMB capability and permits fresh verification');
  // Removing a group changes the employee token fingerprint; restore immediately.
  await adminCommand(admin, 'group.members', { group_id: fixture.group_id, user_ids: [fixture.user_id], add: false });
  try { assert.equal((await (await checked(await employee.request.get(origin + '/api/files/status'), 200)).json()).connected, false); }
  finally { await adminCommand(admin, 'group.members', { group_id: fixture.group_id, user_ids: [fixture.user_id], add: true }); }
  await adLogin(employee); pass('Effective AD group change invalidates a previously authenticated SMB session');
  await adminCommand(admin, 'share.save', { name: readonly, comment: '员工文件只读测试', groups: [fixture.group_id], read_only: false });
  try { assert.equal((await (await checked(await employee.request.get(origin + '/api/files/status'), 200)).json()).connected, false); }
  finally { await adminCommand(admin, 'share.save', { name: readonly, comment: '员工文件只读测试', groups: [fixture.group_id], read_only: true }); }
  await adLogin(employee); pass('A connected share policy change invalidates existing SMB admission before further access');
  const oldCookies = await ec.cookies();
  await checked(await employee.request.post(origin + '/api/auth/sign-out', { headers, data: {} }), 200);
  await checked(await employee.request.get(origin + '/api/files/status'), 401);
  await login(employee, fixture.assay_email, fixture.assay_password);
  assert.equal((await (await employee.request.get(origin + '/api/files/status')).json()).connected, false);
  pass('Raw Assay sign-out revokes employee file access; a new Assay login cannot reuse the previous SMB session');
  const old = await browser.newContext({ ignoreHTTPSErrors: true }); await old.addCookies(oldCookies);
  await checked(await old.request.get(origin + '/api/files/status'), 401); await old.close();
  const history = await (await checked(await admin.request.get(origin + '/api/samba/operations'), 200)).json();
  for (const secret of [fixture.ad_password, fixture.assay_password, adminPassword]) assert(!JSON.stringify(history).includes(secret));
  assert(history.some(op => op.action === 'file.upload' && op.state === 'succeeded')); pass('File operations are audited without AD or Assay passwords');
  fs.writeFileSync(dir + '/files-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => {
  let message = error.message; for (const secret of [adminPassword, fixture.ad_password, fixture.assay_password]) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
