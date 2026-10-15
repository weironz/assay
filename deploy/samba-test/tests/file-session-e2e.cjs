// End-to-end company login, long-lived file lease and unified authentication recovery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const origin = require('./test-origin.cjs');
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const f = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const results = []; let browser, context;
const pass = name => { results.push(name); console.log('PASS ' + name); };
async function api(path, method = 'GET', data, expected = 200) {
  const response = await context.request.fetch(origin + '/api' + path, { method, headers: { Origin: origin }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), expected, 'Response mismatch for ' + path); return response.json();
}
(async () => {
  assert(f.ad_name.startsWith('qa_'));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
  let passwordPrompts = 0, signOuts = 0;
  page.on('request', r => { const path = new URL(r.url()).pathname; if (r.method() === 'POST' && path === '/api/files/session') passwordPrompts++; if (r.method() === 'POST' && path === '/api/auth/sign-out') signOuts++; });
  const noConnectionControls = async () => {
    assert.equal(await page.locator('input[type=password]').count(), 0);
    for (const text of ['公司文件连接已断开', '重新登录公司账号', '其他连接方式', '验证自己的 AD 密码', '断开文件会话'])
      assert.equal(await page.getByText(text, { exact: true }).count(), 0);
  };
  const companySignIn = async (filesUnavailable = false) => {
    await page.locator('form input').first().fill(f.ad_name); await page.locator('input[type=password]').fill(f.ad_password);
    await page.locator('form button[type=submit]').click(); await page.waitForURL('**/files');
    if (filesUnavailable) await page.getByRole('heading', { name: '文件服务暂不可用', exact: true }).waitFor();
    else await page.getByRole('region', { name: '共享目录浏览器', exact: true }).waitFor();
    await noConnectionControls();
  };
  await page.goto(origin + '/login'); await companySignIn();
  let status = await api('/files/status'); const login = await api('/auth/get-session');
  assert(status.connected && status.followsWebSession); assert(status.shares.includes(f.share));
  assert(status.expiresAt > Date.now() / 1000 + 3600);
  assert(Math.abs(status.expiresAt * 1000 - new Date(login.session.expiresAt).getTime()) < 3000);
  assert.equal(passwordPrompts, 0); await noConnectionControls();
  pass('One company sign-in opens shared folders; file expiry follows the Web login and exceeds the old one-hour limit');
  if (process.env.SAMBA_E2E_SESSION_PROBE) {
    const probe = action => JSON.parse(execFileSync('python3', [process.env.SAMBA_E2E_SESSION_PROBE], { input: JSON.stringify({ action, token: login.session.token, userId: f.assay_user_id }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    const aged = probe('age'); assert(aged.fileRemaining <= 120 && aged.capabilityTtl <= 120);
    // A business request, without visiting any file endpoint, slides Web auth.
    assert.equal((await api('/me')).id, f.assay_user_id);
    let renewed;
    for (let i = 0; i < 10; i++) { renewed = probe('inspect'); if (renewed.fileRemaining > 3600 && renewed.capabilityTtl > 3600) break; await page.waitForTimeout(300); }
    assert(renewed.fileRemaining > 3600 && renewed.capabilityTtl > 3600);
    pass('Business-only sliding login renewal also extends the existing SMB lease and capability without a file request');
  }
  await page.reload(); await page.getByRole('region', { name: '共享目录浏览器', exact: true }).waitFor();
  status = await api('/files/status'); assert(status.connected && status.followsWebSession); assert.equal(passwordPrompts, 0);
  pass('Reloading the file module reuses the existing employee connection without another password exchange');

  const oldCookies = await context.cookies();
  await api('/files/session', 'DELETE'); await page.reload();
  await page.waitForURL('**/login');
  assert.equal(signOuts, 1); await api('/me', 'GET', undefined, 401);
  pass('A missing employee connection automatically returns to unified login once, with no connection panel or separate AD prompt');
  await companySignIn(); status = await api('/files/status'); assert(status.connected && status.followsWebSession); assert.equal(passwordPrompts, 0);
  const old = await browser.newContext({ ignoreHTTPSErrors: true }); await old.addCookies(oldCookies);
  assert.equal((await old.request.get(origin + '/api/files/status')).status(), 401); await old.close();
  pass('Signing in once rebuilds the employee file connection; old cookies cannot regain access');
  // Inject only read-only HTTP failures; real AD/SMB and existing data stay unchanged.
  const statusRoute = '**/api/files/status';
  await page.route(statusRoute, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary test outage' }) }));
  await page.reload(); await page.getByRole('heading', { name: '文件服务暂不可用', exact: true }).waitFor();
  await noConnectionControls(); assert.equal(new URL(page.url()).pathname, '/files'); assert.equal(signOuts, 1);
  assert.equal((await api('/me')).id, f.assay_user_id);
  await page.screenshot({ path: dir + '/file-service-unavailable.png', fullPage: true });
  await page.unroute(statusRoute); await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('region', { name: '共享目录浏览器', exact: true }).waitFor(); await noConnectionControls();
  pass('A temporary file status outage shows service retry without signing out; recovery restores the folder list');

  // A normal login can succeed while its optional file service is unavailable.
  // Override response metadata only, without changing AD or gateway configuration.
  const loginRoute = '**/api/auth/sign-in/unified';
  await page.route(loginRoute, async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200);
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, filesConnected: false, destination: '/dashboard' } });
  });
  await api('/files/session', 'DELETE');
  await page.getByRole('searchbox', { name: '搜索共享目录', exact: true }).fill(f.share);
  await page.getByRole('button', { name: '打开文件夹：' + f.share, exact: true }).click();
  await page.waitForURL('**/login'); assert.equal(signOuts, 2);
  pass('File operation expiry also returns to unified login without showing connection controls');
  await page.route(statusRoute, route => route.fulfill({ json: { connected: false, identity: status.identity, reconnectWithCompanyLogin: true } }));
  await companySignIn(true); await page.waitForTimeout(700);
  assert.equal(new URL(page.url()).pathname, '/files'); assert.equal(signOuts, 2); await noConnectionControls();
  assert.equal((await api('/me')).id, f.assay_user_id);
  pass('Successful company login with an unavailable optional file service stays on service status, without an authentication loop');
  await page.unroute(statusRoute); await page.unroute(loginRoute);
  await page.getByRole('button', { name: '重试', exact: true }).click(); await page.waitForURL('**/login');
  assert.equal(signOuts, 3); await companySignIn(); assert.equal(passwordPrompts, 0);
  pass('Retry after failed initial file access uses unified login and returns directly to shared folders');

  await api('/auth/sign-out', 'POST', {});
  await api('/files/status', 'GET', undefined, 401);
  pass('Sign-out invalidates the long-lived file connection and prevents status/renewal access');
  fs.writeFileSync(dir + '/file-session-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => { console.error(error.message.replaceAll(f.ad_password, '[redacted]')); process.exitCode = 1; }).finally(async () => { try { if (context) await api('/auth/sign-out', 'POST', {}); } catch {} await browser?.close(); });
