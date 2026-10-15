// Password reset regression uses an existing qa_* fixture, never a user-created account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const fixturePath = dir + '/fixture.json';
const f = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const nextPassword = 'Aa9!' + randomBytes(20).toString('base64url');
const secrets = [adminPassword, f.ad_password, f.assay_password, nextPassword];
const results = [];
let browser;
const pass = name => { results.push(name); console.log('PASS ' + name); };
async function login(page, email, password) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
  await page.goto(origin + '/login'); await page.locator('form input').first().fill(email);
  await page.locator('input[type=password]').fill(password); await page.locator('form button[type=submit]').click(); await page.waitForURL('**/dashboard');
}
async function checked(r, status) { assert.equal(r.status(), status); return r; }
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: `${new URL(origin).hostname},127.0.0.1,localhost` } } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  await login(page, 'admin@assay.test', adminPassword);
  const before = await (await checked(await page.request.get(origin + '/api/samba/snapshot'), 200)).json();
  const me = await (await checked(await page.request.get(origin + '/api/me'), 200)).json();
  const bindingsBefore = before.bindings.filter(b => b.userId === me.id);
  const employee = before.users.find(u => u.id === f.user_id);
  assert(employee && employee.name.startsWith('qa_') && employee.name === f.ad_name, 'Only the generated QA employee may be changed');
  const commands = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/samba/commands' && request.method() === 'POST') {
      const body = request.postDataJSON(); commands.push({ action: body.action, id: body.args?.id });
    }
  });
  await page.goto(origin + '/samba/users/' + f.user_id);
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '重置 AD 密码', exact: true });
  const short = dialog.getByLabel('新的 AD 密码', { exact: true }); await short.fill('short7');
  await dialog.getByRole('button', { name: '确认并验证身份', exact: true }).click();
  assert.equal(await short.evaluate(input => input.validity.tooShort), true);
  assert.equal(await page.locator('[data-step-up-dialog]').count(), 0); assert.equal(commands.length, 0);
  await dialog.getByText('至少 8 个字符，并符合公司 AD 的密码复杂度与历史密码要求。', { exact: true }).waitFor();
  pass('Short new AD passwords are blocked in the editor before requesting an Assay challenge');
  await short.fill(nextPassword); await dialog.getByRole('button', { name: '确认并验证身份', exact: true }).click();
  dialog = page.locator('[data-step-up-dialog]');
  await dialog.getByLabel('当前 Assay 登录密码', { exact: true }).fill('Wrong-Assay-Password9!');
  await dialog.getByRole('button', { name: '验证并继续', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '验证失败，或登录会话已过期。' }).waitFor();
  assert.equal(commands.length, 0); await checked(await page.request.get(origin + '/api/me'), 200);
  pass('The challenge names the Assay credential; a wrong Assay password does not log the user out or reset AD');
  await page.route('**/api/samba/commands', route => route.fulfill({ status: 400, json: { message: 'private protocol detail' } }));
  await dialog.getByLabel('当前 Assay 登录密码', { exact: true }).fill(adminPassword);
  await dialog.getByRole('button', { name: '验证并继续', exact: true }).click();
  const alert = dialog.getByRole('alert'); await alert.filter({ hasText: '身份验证已通过，但当前操作未完成。' }).waitFor();
  assert((await alert.innerText()).includes('请求未通过验证'));
  assert(!(await alert.innerText()).includes('网络连接')); assert(!(await alert.innerText()).includes('private protocol detail'));
  await page.screenshot({ path: dir + '/password-reset-validation.png', fullPage: true });
  pass('A rejected mutation is distinguished from successful identity verification without leaking raw errors');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await page.unroute('**/api/samba/commands');
  const challenge = await checked(await page.request.post(origin + '/api/me/security/step-up', { data: { purpose: 'samba', password: adminPassword } }), 201);
  const rejected = await checked(await page.request.post(origin + '/api/samba/commands', { headers: { 'x-step-up-token': (await challenge.json()).stepUpToken }, data: { requestId: randomUUID(), action: 'user.password', args: { id: f.user_id, password: 'short7' } } }), 400);
  const rejectedBody = await rejected.json(); assert(rejectedBody.message.includes('8–512')); assert(!JSON.stringify(rejectedBody).includes('short7'));
  pass('The API rejects bypassed password validation with a useful message and no password echo');
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '重置 AD 密码', exact: true });
  await dialog.getByLabel('新的 AD 密码', { exact: true }).fill(nextPassword);
  await dialog.getByRole('button', { name: '确认并验证身份', exact: true }).click();
  dialog = page.locator('[data-step-up-dialog]'); await dialog.getByLabel('当前 Assay 登录密码', { exact: true }).fill(adminPassword);
  await dialog.getByRole('button', { name: '验证并继续', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.getByText('操作已完成', { exact: true }).waitFor();
  f.ad_password = nextPassword; fs.writeFileSync(fixturePath, JSON.stringify(f, null, 2), { mode: 0o600 });
  pass('A policy-compliant new AD password can be reset through the real Web flow');
  const ec = await browser.newContext({ ignoreHTTPSErrors: true }); const employeePage = await ec.newPage();
  await login(employeePage, f.assay_email, f.assay_password);
  const verified = await checked(await employeePage.request.post(origin + '/api/files/session', { headers: { Origin: origin }, data: { password: nextPassword } }), 201);
  assert.equal((await verified.json()).connected, true);
  await checked(await employeePage.request.delete(origin + '/api/files/session', { headers: { Origin: origin } }), 200);
  await checked(await employeePage.request.post(origin + '/api/auth/sign-out', { headers: { Origin: origin }, data: {} }), 200);
  pass('The employee opens an own LDAP/SMB file session with the new AD password');
  const after = await (await checked(await page.request.get(origin + '/api/samba/snapshot'), 200)).json();
  assert.deepEqual(after.bindings.filter(b => b.userId === me.id), bindingsBefore);
  assert(commands.every(c => c.action === 'user.password' && c.id === f.user_id));
  await checked(await page.request.post(origin + '/api/auth/sign-out', { headers: { Origin: origin }, data: {} }), 200);
  pass('All reset requests target only the generated QA employee; existing administrator links remain unchanged');
  fs.writeFileSync(dir + '/password-reset-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => {
  let message = error.message; for (const secret of secrets) message = message.replaceAll(secret, '[redacted]'); console.error(message); process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
