// Explicit business grants for an existing generated QA employee. No AD writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const origin = require('./test-origin.cjs');
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const f = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const results = [];
let browser, admin, employee, group, originalRoles, rolesChanged = false;
const added = new Set();
const pass = name => { results.push(name); console.log('PASS ' + name); };
async function api(context, method, path, data, status = 200) {
  const response = await context.request.fetch(origin + '/api' + path, { method, headers: { Origin: origin }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), status, 'Unexpected response for ' + path);
  return response.json();
}
async function mapping(roleName, remove = false) {
  await api(admin, remove ? 'DELETE' : 'POST', '/directory/mappings', { groupSid: group.sid, roleName }, remove ? 200 : 201);
  if (remove) added.delete(roleName); else added.add(roleName);
}
(async () => {
  assert(f.ad_name.startsWith('qa_'));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',localhost,127.0.0.1' } } : {}) });
  admin = await browser.newContext({ ignoreHTTPSErrors: true });
  await admin.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
  await api(admin, 'POST', '/auth/sign-in/email', { email: 'admin@assay.test', password: adminPassword });
  const snapshot = await api(admin, 'GET', '/samba/snapshot');
  assert.equal(snapshot.domain.toLowerCase(), 'dc=assay,dc=test');
  group = snapshot.groups.find(g => g.id === f.group_id);
  const principal = snapshot.users.find(u => u.id === f.user_id && u.name === f.ad_name);
  assert(principal && group && group.name.includes('qa_') && group.members.includes(principal.dn));
  assert(group.members.every(dn => snapshot.users.some(u => u.dn === dn && u.name.startsWith('qa_'))), 'Only map a group containing generated QA users');
  const settings = await api(admin, 'GET', '/directory/settings');
  assert(!settings.mappings.some(m => m.groupSid === group.sid), 'Use an unmapped QA group');
  originalRoles = (await api(admin, 'GET', '/users/' + f.assay_user_id)).roles;
  assert(!originalRoles.includes('admin'));
  if (originalRoles.length) { await api(admin, 'PATCH', '/users/' + f.assay_user_id, { roleNames: [] }); rolesChanged = true; }
  assert(settings.roles.some(r => r.name === 'requester'));
  assert(!settings.roles.some(r => r.name === 'admin'));
  const administrator = await api(admin, 'GET', '/me');
  assert(administrator.roles.includes('admin') && administrator.passwordSource === 'local');
  pass('Local emergency administrator keeps access; requester is an explicit mapping option and admin stays manual');

  employee = await browser.newContext({ ignoreHTTPSErrors: true });
  await employee.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
  const login = await api(employee, 'POST', '/auth/sign-in/directory', { username: f.ad_name, password: f.ad_password });
  assert.equal(login.filesConnected, true);
  let me = await api(employee, 'GET', '/me');
  assert.deepEqual(me.roles, []); assert.deepEqual(me.permissions, []);
  const page = await employee.newPage();
  const nav = () => page.getByRole('navigation', { name: '业务模块', exact: true });
  await page.goto(origin + '/files');
  await page.getByRole('region', { name: '共享目录浏览器', exact: true }).waitFor();
  assert.deepEqual((await nav().getByRole('link').allTextContents()).map(s => s.trim()), ['文件管理']);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  const files = await api(employee, 'GET', '/files/status'); assert(files.connected && files.shares.includes(f.share));
  await page.screenshot({ path: dir + '/directory-file-only.png', fullPage: true });
  pass('AD sign-in grants no implicit business role and opens only authorized shared files');
  for (const path of ['/tickets', '/tickets/nonexistent-ticket', '/inventory/balances', '/assets']) await api(employee, 'GET', path, undefined, 403);
  await api(employee, 'POST', '/tickets', { title: 'Must not be created' }, 403);
  pass('Direct ticket reads, creates, assets and inventory APIs reject the file-only employee');
  for (const path of ['/tickets', '/tickets/new', '/tickets/nonexistent-ticket']) {
    await page.goto(origin + path); await page.getByText('无权访问该页面', { exact: true }).waitFor();
  }
  pass('Direct ticket page URLs also show access denied');

  await mapping('requester');
  me = await api(employee, 'GET', '/me'); assert.deepEqual(me.roles, ['requester']);
  await api(employee, 'GET', '/tickets');
  await api(employee, 'GET', '/inventory/balances', undefined, 403);
  await page.goto(origin + '/files'); await nav().getByRole('link', { name: '工单系统', exact: true }).waitFor();
  pass('Explicit requester mapping grants ticket access to the current login without granting inventory');
  await mapping('requester', true);
  assert.deepEqual((await api(employee, 'GET', '/me')).roles, []);
  await api(employee, 'GET', '/tickets', undefined, 403);
  await page.reload(); await page.getByRole('region', { name: '共享目录浏览器', exact: true }).waitFor();
  assert.deepEqual((await nav().getByRole('link').allTextContents()).map(s => s.trim()), ['文件管理']);
  assert((await api(employee, 'GET', '/files/status')).connected);
  pass('Removing requester mapping immediately denies tickets while the employee SMB connection stays usable');

  await api(admin, 'PATCH', '/users/' + f.assay_user_id, { roleNames: ['requester'] }); rolesChanged = true;
  await mapping('inventory_manager');
  me = await api(employee, 'GET', '/me'); assert(me.roles.includes('requester') && me.roles.includes('inventory_manager'));
  await api(employee, 'GET', '/inventory/balances');
  await mapping('inventory_manager', true);
  me = await api(employee, 'GET', '/me'); assert.deepEqual(me.roles, ['requester']);
  await api(employee, 'GET', '/tickets'); await api(employee, 'GET', '/inventory/balances', undefined, 403);
  pass('Removing a directory grant preserves the independent manual business role');
  const management = await admin.newPage(); await management.goto(origin + '/users');
  await management.getByRole('row').filter({ hasText: 'AD · ' + f.ad_name }).getByRole('button', { name: '编辑角色', exact: true }).click();
  const dialog = management.getByRole('dialog');
  for (const box of await dialog.locator('input[type=checkbox]:checked').all()) await box.uncheck();
  await dialog.getByText('未分配业务角色，仅保留无需业务角色的入口。', { exact: true }).waitFor();
  const save = dialog.getByRole('button', { name: '保存', exact: true }); assert(await save.isEnabled());
  const update = management.waitForResponse(r => r.url().endsWith('/api/users/' + f.assay_user_id) && r.request().method() === 'PATCH');
  await save.click(); assert.equal((await update).status(), 200);
  await management.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual((await api(employee, 'GET', '/me')).roles, []);
  await api(employee, 'GET', '/tickets', undefined, 403);
  if (originalRoles.length) await api(admin, 'PATCH', '/users/' + f.assay_user_id, { roleNames: originalRoles });
  rolesChanged = false;
  assert.deepEqual((await api(admin, 'GET', '/users/' + f.assay_user_id)).roles, originalRoles);
  assert(!(await api(admin, 'GET', '/directory/settings')).mappings.some(m => m.groupSid === group.sid));
  pass('The administrator UI can revoke the final business role without secondary verification; QA roles and mappings return to their initial state');
  fs.writeFileSync(dir + '/directory-authorization-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => {
  let message = error.message;
  for (const secret of [adminPassword, f.ad_password, f.assay_password]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}).finally(async () => {
  try {
    for (const role of [...added]) await mapping(role, true);
    if (rolesChanged) await api(admin, 'PATCH', '/users/' + f.assay_user_id, { roleNames: originalRoles });
    for (const context of [employee, admin]) if (context) await api(context, 'POST', '/auth/sign-out', {});
  } catch { console.error('QA authorization cleanup failed'); process.exitCode = 1; }
  await browser?.close();
});
