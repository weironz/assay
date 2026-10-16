// All APIs are intercepted. This suite never creates an actual AD group.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = require('./test-origin.cjs');
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  for (const prefix of ['dept_', 'qa_', '']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const commands = [];
    const groups = [{ id: 'a'.repeat(32), name: prefix + 'existing', description: 'Existing group', members: [], manageable: true }];
    await context.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
    await context.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      let status = 200, data = {};
      if (path === '/api/me') data = { id: 'admin-fixture', name: 'Administrator', email: 'admin@example.test', roles: ['admin'], permissions: ['samba:read', 'samba:manage'], status: 'ACTIVE' };
      else if (path === '/api/modules') data = { directory: true, files: true };
      else if (path === '/api/notifications/unread-count') data = { count: 0 };
      else if (path === '/api/samba/snapshot') data = { enabled: true, domain: 'DC=example,DC=test', groupPrefix: prefix, readOnly: false, users: [], groups, shares: [], bindings: [], assayUsers: [] };
      else if (path === '/api/me/security') data = { privileged: true, enrolled: false, privilegedMfaMode: 'optional', stepUpExemptPurposes: ['samba'] };
      else if (path === '/api/samba/commands') {
        const body = request.postDataJSON(); commands.push(body);
        assert.equal(body.action, 'group.create');
        assert(!body.args.name.startsWith(prefix + prefix) || !prefix);
        if (body.args.name === prefix + 'collision') { status = 409; data = { code: 'SAMBA_GROUP_NAME_EXISTS' }; }
        else { groups.push({ id: String(commands.length).repeat(32), name: body.args.name, description: body.args.description, members: [], manageable: true }); data = { id: body.requestId, state: 'succeeded' }; }
      } else if (request.method() !== 'GET') throw Error('Unexpected write: ' + path);
      await route.fulfill({ status, json: data });
    });
    const page = await context.newPage();
    await page.goto(origin + '/samba/groups');
    const open = async () => { await page.getByRole('button', { name: '新增用户组', exact: true }).click(); const d = page.getByRole('dialog', { name: '新增用户组', exact: true }); await d.getByLabel('说明', { exact: true }).fill('Fixture group'); return d; };
    let dialog = await open();
    for (const [name, error] of [['bad name', '2–48'], [prefix + 'existing', '已存在'], ['administrator', '保留名']]) {
      await dialog.getByLabel('用户组名称', { exact: true }).fill(name); await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: error }).waitFor(); assert.equal(commands.length, 0);
    }
    if (prefix) {
      await dialog.getByLabel('用户组名称', { exact: true }).fill('team');
      await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: prefix }).waitFor(); assert.equal(commands.length, 0);
    }
    const literal = prefix + 'team';
    await dialog.getByLabel('用户组名称', { exact: true }).fill(literal);
    assert.equal(await dialog.getByLabel('用户组名称', { exact: true }).inputValue(), literal);
    await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await page.getByRole('link', { name: literal, exact: true }).waitFor();
    assert.equal(commands.length, 1); assert.equal(commands[0].args.name, literal);
    dialog = await open(); await dialog.getByLabel('用户组名称', { exact: true }).fill('dept_second');
    if (prefix && prefix !== 'dept_') {
      await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: prefix }).waitFor(); assert.equal(commands.length, 1);
      await dialog.getByLabel('用户组名称', { exact: true }).fill(prefix + 'second');
    }
    const second = await dialog.getByLabel('用户组名称', { exact: true }).inputValue();
    await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await page.getByRole('link', { name: second, exact: true }).waitFor(); assert.equal(commands.length, 2); assert.equal(commands[1].args.name, second);
    dialog = await open(); await dialog.getByLabel('用户组名称', { exact: true }).fill(prefix + 'collision'); await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await page.getByRole('dialog').getByRole('alert').filter({ hasText: '用户组名称已存在' }).waitFor();
    await page.waitForTimeout(250); assert.equal(commands.length, 3, 'rejected writes are never replayed automatically');
    console.log('PASS literal group names, visible legacy policy, reserved names, validation and duplicate response; prefix=' + JSON.stringify(prefix));
    await context.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
