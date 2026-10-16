// UI-only fixtures intercept every API request: never change a real employee password.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = require('./test-origin.cjs');
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  const errors = [];
  for (const mfa of [false, true]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    let posts = 0, challenges = 0, mode = 'old', release;
    const user = { id: 'fixture', name: 'Employee', email: 'employee@example.test', roles: [], permissions: [], status: 'ACTIVE', passwordSource: 'directory', twoFactorEnabled: mfa };
    await context.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
    await context.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      let status = 200, data = {};
      if (path === '/api/me') data = user;
      else if (path === '/api/modules') data = { files: true, directory: true };
      else if (path === '/api/samba/me') data = { identity: { accountName: 'employee', domain: 'example.test' } };
      else if (path === '/api/samba/me/password') {
        posts++;
        const body = req.postDataJSON();
        assert.equal(body.old_password, 'OldFixture9!');
        assert.equal(body.password, 'NewFixture9!');
        assert.equal(body.code, mfa ? '123456' : undefined);
        assert.equal(req.headers()['x-step-up-token'], undefined);
        assert.match(body.requestId, /^[0-9a-f-]{36}$/);
        if (mode === 'old' || mode === 'policy') { status = 400; data = { code: mode === 'old' ? 'AD_CURRENT_PASSWORD_INVALID' : 'AD_PASSWORD_COMPLEXITY' }; }
        else { await new Promise(resolve => { release = resolve; }); data = { id: body.requestId, state: 'succeeded' }; }
      } else if (path === '/api/me/security/step-up') { challenges++; status = 500; }
      else if (path === '/api/notifications/unread-count') data = { count: 0 };
      else if (path === '/api/me/security') data = { enrolled: mfa, privileged: false, privilegedMfaMode: 'optional' };
      else if (path === '/api/auth/two-factor/list-backup-codes') data = [];
      await route.fulfill({ status, json: data });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/settings?tab=security');
    const card = page.getByRole('region', { name: '公司 AD 密码', exact: true });
    await card.getByLabel('当前 AD 密码', { exact: true }).fill('OldFixture9!');
    await card.getByLabel('新的 AD 密码', { exact: true }).fill('NewFixture9!');
    await card.getByLabel('确认新的 AD 密码', { exact: true }).fill('Mismatch9!');
    if (mfa) await card.getByLabel('动态验证码', { exact: true }).fill('123456');
    const button = card.getByRole('button', { name: '修改公司密码', exact: true });
    await button.click();
    await card.getByText('两次新密码不一致', { exact: true }).waitFor();
    assert.equal(posts, 0);
    await card.getByLabel('确认新的 AD 密码', { exact: true }).fill('NewFixture9!');
    for (const [failure, text] of [['old', '当前 AD 密码不正确'], ['policy', '复杂度要求']]) {
      mode = failure;
      if (mfa) await card.getByLabel('动态验证码', { exact: true }).fill('123456');
      await button.click(); await card.getByRole('status').filter({ hasText: text }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await card.getByLabel('新的 AD 密码', { exact: true }).inputValue(), 'NewFixture9!');
    }
    mode = 'success';
    if (mfa) await card.getByLabel('动态验证码', { exact: true }).fill('123456');
    await button.click(); await page.waitForFunction(() => document.querySelector('section[aria-label="公司 AD 密码"] form')?.getAttribute('aria-busy') === 'true');
    assert.equal(await card.getByLabel('当前 AD 密码', { exact: true }).isDisabled(), true);
    assert.equal(posts, 3);
    release();
    await card.getByText('公司 AD 密码已修改，请使用新密码重新登录。', { exact: true }).waitFor();
    assert.equal(await card.locator('input[type=password]').count(), 0);
    assert.equal(await card.getByRole('button', { name: '重新登录', exact: true }).count(), 1);
    assert.equal(challenges, 0);
    assert.equal(posts, 3);
    console.log('PASS single-form self-password change, mismatch, old password, policy errors, pending state and success; MFA=' + mfa);
    await context.close();
  }
  assert.deepEqual(errors, []);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
