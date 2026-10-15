// Real isolated AD/SMB plus unified/local administrator browser sign-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const fixture = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const results = [], contexts = [];
const pass = name => { results.push(name); console.log('PASS ' + name); };
let browser, page;
async function api(context, path, method = 'GET', data, status = 200) {
  const response = await context.request.fetch(origin + '/api' + path, { method, headers: { Origin: origin }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), status, 'Unexpected status for ' + path); return response.json();
}
(async () => {
  assert(fixture.ad_name.startsWith('qa_'), 'Use only a generated QA employee');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  const context = async () => {
    const value = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } }); contexts.push(value);
    await value.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN')); return value;
  };
  const admin = await context(); page = await admin.newPage();
  await page.goto(origin + '/login');
  await page.getByLabel('账号', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '公司账号', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '本地账号', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '注册账号', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '注册', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '管理员应急登录', exact: true }).count(), 0);
  assert.equal(await page.getByPlaceholder('用户名或邮箱', { exact: true }).count(), 1);
  await page.screenshot({ path: dir + '/unified-login-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: dir + '/unified-login-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  pass('One accessible account/password form replaces provider selectors and registration tabs on desktop and mobile');
  const login = async (target, username, password, destination, status = 200) => {
    await target.getByLabel('账号', { exact: true }).fill(username); await target.getByLabel('密码', { exact: true }).fill(password);
    const response = target.waitForResponse(r => r.request().method() === 'POST' && /\/api\/auth\/sign-in\/(unified|local-admin)$/.test(new URL(r.url()).pathname));
    await target.getByRole('button', { name: '登录', exact: true }).click(); const result = await response;
    assert.equal(result.status(), status, 'Unexpected unified login result');
    if (destination) await target.waitForURL('**/' + destination);
    return result;
  };
  await login(page, 'admin@assay.test', adminPassword, 'dashboard');
  const original = await api(admin, '/me'); assert(original.roles.includes('admin')); assert.equal(original.passwordSource, 'local');
  pass('Existing administrator credentials use normal unified sign-in and preserve the original account and roles');

  const recovery = await context(); const recoveryPage = await recovery.newPage();
  await recoveryPage.goto(origin + '/login/admin');
  await recoveryPage.getByRole('heading', { name: '管理员应急登录', exact: true }).waitFor();
  await login(recoveryPage, fixture.ad_name, fixture.ad_password, undefined, 401);
  await recoveryPage.getByText('账号或密码错误', { exact: true }).waitFor();
  await login(recoveryPage, 'admin@assay.test', adminPassword, 'dashboard');
  assert.equal((await api(recovery, '/me')).id, original.id);
  pass('The secondary administrator recovery route rejects AD employees and signs in the independent local administrator');

  const employee = await context(); const employeePage = await employee.newPage();
  let unified = 0, alternative = 0;
  employeePage.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/api/auth/sign-in/unified') unified++;
    if (request.method() === 'POST' && ['/api/auth/sign-in/email', '/api/auth/sign-in/directory', '/api/files/session'].includes(path)) alternative++;
  });
  await employeePage.goto(origin + '/login'); await login(employeePage, fixture.ad_name, fixture.ad_password, 'files');
  const me = await api(employee, '/me'); assert.equal(me.id, fixture.assay_user_id); assert.equal(me.passwordSource, 'directory');
  assert.equal((await api(employee, '/files/status')).connected, true);
  await employeePage.getByRole('region', { name: '共享目录浏览器', exact: true }).waitFor();
  assert.equal(await employeePage.locator('input[type=password]').count(), 0); assert.equal(unified, 1); assert.equal(alternative, 0);
  pass('Employee username sign-in sends one request and opens authorized SMB folders without a second password prompt');
  await api(employee, '/auth/sign-out', 'POST', {});
  await employeePage.goto(origin + '/login'); await login(employeePage, me.email.toUpperCase(), fixture.ad_password, 'files');
  assert.equal((await api(employee, '/me')).id, me.id); assert.equal(alternative, 0);
  pass('The same employee email alias resolves to the existing AD GUID and business user ID');
  await api(employee, '/auth/sign-out', 'POST', {});
  await employeePage.goto(origin + '/login');
  const before = unified;
  await login(employeePage, fixture.ad_name, 'deliberately-wrong-test-only-password', undefined, 401);
  await employeePage.getByText('账号或密码错误', { exact: true }).waitFor();
  assert.equal(unified, before + 1); assert.equal(alternative, 0);
  pass('A rejected AD password produces one generic error without a local authentication fallback');

  const options = await api(employee, '/auth/login/options'); assert.equal(options.registrationEnabled, false);
  await api(employee, '/auth/sign-up/email', 'POST', { email: 'qa-unregistered-' + Date.now() + '@assay.test', name: 'Must not exist', password: 'not-used-test-only-password' }, 403);
  await employeePage.route('**/api/auth/login/options', route => route.fulfill({ json: { ...options, registrationEnabled: true } }));
  await employeePage.reload(); await employeePage.getByRole('button', { name: '注册账号', exact: true }).click();
  await employeePage.getByRole('heading', { name: '注册', exact: true }).waitFor();
  assert.equal(await employeePage.locator('input[type=email]').count(), 1);
  await employeePage.getByRole('button', { name: '返回登录', exact: true }).click();
  await employeePage.getByLabel('账号', { exact: true }).waitFor();
  await employeePage.unrouteAll();
  pass('Registration is enforced by the server; a read-only option simulation reveals the optional link and correct signup form');

  await employeePage.route('**/api/auth/oidc/provider', route => route.fulfill({ json: { enabled: true, name: '测试 SSO' } }));
  await employeePage.reload();
  await employeePage.getByRole('button', { name: '使用 测试 SSO 登录', exact: true }).waitFor();
  await employeePage.goto(origin + '/login?oidc_mfa=1');
  await employeePage.getByRole('heading', { name: '两步验证', exact: true }).waitFor();
  pass('Optional OIDC remains a separate SSO button and its pending-MFA screen still opens');
  fs.writeFileSync(dir + '/unified-login-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(async error => {
  if (page) await page.screenshot({ path: dir + '/unified-login-failure.png', fullPage: true }).catch(() => {});
  let message = error.message; for (const secret of [adminPassword, fixture.ad_password, fixture.assay_password]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}).finally(async () => {
  for (const context of contexts) { try { await api(context, '/auth/sign-out', 'POST', {}); } catch {} }
  await browser?.close();
});
