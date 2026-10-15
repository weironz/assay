// Only the generated qa_* employee in the isolated domain may be reset.
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
async function checked(r, status) { assert.equal(r.status(), status); return r; }
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
  await page.goto(origin + '/login');
  if ((await (await page.request.get(origin + '/api/auth/directory/provider')).json()).enabled) await page.getByRole('button', { name: '本地账号', exact: true }).click();
  await page.locator('form input').first().fill('admin@assay.test');
  await page.locator('input[type=password]').fill(adminPassword);
  await page.locator('form button[type=submit]').click(); await page.waitForURL('**/dashboard');
  const before = await (await checked(await page.request.get(origin + '/api/samba/snapshot'), 200)).json();
  assert.equal(before.domain.toLowerCase(), 'dc=assay,dc=test');
  const me = await (await checked(await page.request.get(origin + '/api/me'), 200)).json();
  assert(me.roles.includes('admin'));
  const bindingsBefore = before.bindings.filter(b => b.userId === me.id);
  const employee = before.users.find(u => u.id === f.user_id);
  assert(employee && employee.name.startsWith('qa_') && employee.name === f.ad_name);
  const commands = [], challenges = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/me/security/step-up') challenges.push(path);
    if (path === '/api/samba/commands' && request.method() === 'POST') {
      const body = request.postDataJSON(); commands.push({ ...body, token: request.headers()['x-step-up-token'] });
    }
  });
  await page.goto(origin + '/samba/users/' + f.user_id);
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '重置 AD 密码', exact: true });
  await dialog.getByLabel('新的 AD 密码', { exact: true }).fill('short7');
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
  assert.equal(await dialog.getByLabel('新的 AD 密码', { exact: true }).evaluate(input => input.validity.tooShort), true);
  assert.equal(commands.length, 0);
  pass('Short passwords are rejected before any management request');

  await page.route('**/api/samba/commands', route => route.fulfill({ status: 400, json: { message: 'private protocol detail' } }));
  await dialog.getByLabel('新的 AD 密码', { exact: true }).fill(nextPassword);
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
  dialog = page.locator('[data-admin-action]');
  const alert = dialog.getByRole('alert'); await alert.waitFor();
  assert((await alert.innerText()).includes('请求未通过验证'));
  assert(!(await alert.innerText()).includes('网络连接')); assert(!(await alert.innerText()).includes('private protocol detail'));
  assert.equal(await dialog.locator('input[type=password]').count(), 0);
  assert.equal(commands.length, 1);
  await page.waitForTimeout(300); assert.equal(commands.length, 1, 'failed writes are not replayed by renders');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await page.unroute('**/api/samba/commands');
  pass('A rejected write shows a safe error, without a credential prompt or automatic replay');

  const shortCommand = { requestId: randomUUID(), action: 'user.password', args: { id: f.user_id, password: 'short7' } };
  const rejected = await checked(await page.request.post(origin + '/api/samba/commands', { headers: { Origin: origin }, data: shortCommand }), 400);
  const rejectedBody = await rejected.json(); assert(rejectedBody.message.includes('8–512')); assert(!JSON.stringify(rejectedBody).includes('short7'));
  for (const headers of [{}, { Origin: 'https://untrusted.example' }]) {
    await checked(await page.request.post(origin + '/api/samba/commands', { headers, data: shortCommand }), 403);
  }
  pass('Direct administrator writes retain input validation and trusted-origin checks');

  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '重置 AD 密码', exact: true });
  await dialog.getByLabel('新的 AD 密码', { exact: true }).fill('12345678');
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
  dialog = page.locator('[data-admin-action]');
  const policyAlert = dialog.getByRole('alert'); await policyAlert.waitFor();
  const policyMessage = await policyAlert.innerText();
  assert(policyMessage.includes('复杂度') || policyMessage.includes('密码策略'));
  assert(!/LDAP|稍后重试|网络连接/.test(policyMessage));
  const policyOperation = await (await checked(await page.request.get(origin + '/api/samba/operations/' + commands.at(-1).requestId), 200)).json();
  assert.equal(policyOperation.state, 'failed');
  assert(['AD_PASSWORD_COMPLEXITY', 'AD_PASSWORD_POLICY'].includes(policyOperation.result.error_code));
  await page.screenshot({ path: dir + '/password-policy-error.png', fullPage: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const unchangedContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const oldSession = await checked(await unchangedContext.request.post(origin + '/api/auth/sign-in/directory', { headers: { Origin: origin }, data: { username: f.ad_name, password: f.ad_password } }), 200);
  assert.equal((await oldSession.json()).filesConnected, true);
  await checked(await unchangedContext.request.post(origin + '/api/auth/sign-out', { headers: { Origin: origin }, data: {} }), 200);
  await unchangedContext.close();
  pass('A real numeric-only AD password is rejected with a clear policy message; the original password and own SMB access remain valid');

  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '重置 AD 密码', exact: true });
  await dialog.getByLabel('新的 AD 密码', { exact: true }).fill(nextPassword);
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
  await page.getByText('操作已完成', { exact: true }).waitFor();
  await page.locator('[data-admin-action]').waitFor({ state: 'hidden' });
  assert.equal(challenges.length, 0); assert.equal(commands.length, 3);
  assert(commands.every(c => !c.token && c.action === 'user.password' && c.args.id === f.user_id));
  f.ad_password = nextPassword; fs.writeFileSync(fixturePath, JSON.stringify(f, null, 2), { mode: 0o600 });
  pass('Administrator resets AD using only the new password, with no step-up request or duplicate dispatch');

  const audit = await (await checked(await page.request.get(origin + '/api/samba/operations/' + commands.at(-1).requestId), 200)).json();
  assert.equal(audit.actorId, me.id); assert.equal(audit.action, 'user.password'); assert.equal(audit.state, 'succeeded');
  assert(!JSON.stringify(audit).includes(nextPassword));
  pass('The successful reset remains attributable to the administrator and does not expose the password');

  const ec = await browser.newContext({ ignoreHTTPSErrors: true }); const ep = await ec.newPage();
  const provider = await (await page.request.get(origin + '/api/auth/directory/provider')).json();
  if (provider.enabled) {
    await checked(await ep.request.post(origin + '/api/auth/sign-in/directory', { headers: { Origin: origin }, data: { username: f.ad_name, password: nextPassword } }), 200);
  } else {
    await checked(await ep.request.post(origin + '/api/auth/sign-in/email', { headers: { Origin: origin }, data: { email: f.assay_email, password: f.assay_password } }), 200);
  }
  const connected = await checked(await ep.request.post(origin + '/api/files/session', { headers: { Origin: origin }, data: { password: nextPassword } }), 201);
  assert.equal((await connected.json()).connected, true);
  await checked(await ep.request.post(origin + '/api/samba/commands', { headers: { Origin: origin }, data: shortCommand }), 403);
  await checked(await ep.request.delete(origin + '/api/files/session', { headers: { Origin: origin } }), 200);
  await checked(await ep.request.post(origin + '/api/auth/sign-out', { headers: { Origin: origin }, data: {} }), 200);
  pass('The employee can use the new AD password for own SMB access but cannot reset another password');
  const after = await (await checked(await page.request.get(origin + '/api/samba/snapshot'), 200)).json();
  assert.deepEqual(after.bindings.filter(b => b.userId === me.id), bindingsBefore);
  pass('The existing administrator identity association is preserved');
  fs.writeFileSync(dir + '/password-reset-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => {
  let message = error.message; for (const secret of secrets) message = message.replaceAll(secret, '[redacted]'); console.error(message); process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
