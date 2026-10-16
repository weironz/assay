// UI fixtures intercept every API request; no directory or file writes are made.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = require('./test-origin.cjs');
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  const errors = [];
  const cases = [
    { name: 'administrator', roles: ['admin'], permissions: ['samba:read', 'samba:manage'], directory: true, connected: false, manager: true, link: true },
    { name: 'read-only directory manager', roles: ['samba_manager'], permissions: ['samba:read'], directory: true, connected: false, manager: true, link: false },
    { name: 'unlinked employee', roles: [], permissions: [], directory: true, connected: false, manager: false, link: false },
    { name: 'connected employee', roles: [], permissions: [], directory: true, connected: true, manager: false, link: false },
    { name: 'management disabled', roles: ['admin'], permissions: ['samba:read', 'samba:manage'], directory: false, connected: false, manager: false, link: false },
  ];
  for (const fixture of cases) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
    const requests = [];
    await context.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
    await context.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      requests.push({ method: request.method(), path });
      let data = {};
      if (path === '/api/me') data = { id: 'fixture', name: fixture.name, email: 'fixture@example.test', status: 'ACTIVE', passwordSource: fixture.connected ? 'directory' : 'local', roles: fixture.roles, permissions: fixture.permissions };
      else if (path === '/api/modules') data = { files: true, directory: fixture.directory };
      else if (path === '/api/files/status') data = { connected: fixture.connected, identity: fixture.connected ? { accountName: 'employee', domain: 'example.test' } : null, shares: fixture.connected ? ['common'] : [] };
      else if (path === '/api/notifications/unread-count') data = { count: 0 };
      else if (path === '/api/samba/snapshot') data = { enabled: true, domain: 'DC=example,DC=test', users: [], groups: [], shares: [], bindings: [] };
      await route.fulfill({ status: 200, json: data });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/dashboard');
    const folders = page.getByRole('region', { name: '我的共享目录', exact: true });
    await folders.waitFor();
    const destination = fixture.manager ? '/samba/overview' : '/files';
    // AppLayout renders both desktop and mobile navigations.
    const topLinks = await page.locator('header a').filter({ hasText: /^文件管理$/ }).evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    assert(topLinks.length > 0 && topLinks.every(href => href === destination));
    if (fixture.connected) await folders.getByRole('link', { name: '打开共享目录：common', exact: true }).waitFor();
    else if (fixture.roles.includes('admin') || fixture.manager) {
      await folders.getByText(/当前账号用于平台管理/).waitFor();
      assert(!(await folders.innerText()).includes('联系管理员'));
    } else await folders.getByText(/请联系管理员协助/).waitFor();
    if (fixture.manager) {
      const entry = page.getByRole('link', { name: '管理公司文件', exact: true }).first();
      assert.equal(await entry.getAttribute('href'), destination);
      await entry.click(); await page.waitForURL('**/samba/overview');
      await page.getByRole('heading', { name: '管理概览', exact: true }).waitFor();
    }
    await page.goto(origin + '/files');
    if (fixture.connected) await page.getByRole('region', { name: '共享目录浏览器', exact: true }).waitFor();
    else if (fixture.roles.includes('admin') || fixture.manager) {
      await page.getByRole('heading', { name: '当前管理账号未配置个人文件访问', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: '管理公司文件', exact: true }).count(), fixture.manager ? 1 : 0);
      assert.equal(await page.getByRole('link', { name: '配置个人文件身份', exact: true }).count(), fixture.link ? 1 : 0);
      assert(!(await page.locator('main').innerText()).includes('请联系管理员'));
    } else {
      await page.getByRole('heading', { name: '尚未关联公司账号', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: '配置个人文件身份', exact: true }).count(), 0);
    }
    assert(!requests.some(request => request.method !== 'GET'), 'Navigation must not create bindings or file sessions');
    if (!fixture.manager) assert(!requests.some(request => request.path === '/api/samba/snapshot'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log('PASS permission-aware navigation and personal file access guidance: ' + fixture.name);
    await context.close();
  }
  assert.deepEqual(errors, []);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
