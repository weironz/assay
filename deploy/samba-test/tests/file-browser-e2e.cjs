// Real file-manager UI regression. Writes only inside a new QA folder in the
// existing generated employee's share; does not change AD users/groups/ACLs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const f = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const headers = { Origin: origin };
const folder = 'qa-file-browser-' + Date.now();
const results = [];
let browser, employee, admin, page, created = false;
const pass = name => { results.push(name); console.log('PASS ' + name); };
async function api(context, path, method = 'GET', data, status = 200) {
  const response = await context.request.fetch(origin + '/api' + path, { method, headers, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), status, 'Unexpected status for ' + path);
  return response.json();
}
const command = data => api(employee, '/files/commands', 'POST', { share: f.share, ...data }, 201);
const fileURL = path => origin + '/api/files/content?' + new URLSearchParams({ share: f.share, path });
async function put(path, content) {
  const response = await employee.request.put(fileURL(path), { headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: Buffer.from(content) });
  assert.equal(response.status(), 200);
}
async function cleanup() {
  if (!created || !employee) return;
  const listing = await api(employee, '/files/list?' + new URLSearchParams({ share: f.share, path: folder }));
  for (const entry of listing.entries) await command({ action: 'delete', path: folder + '/' + entry.name });
  await command({ action: 'delete', path: folder }); created = false;
}
(async () => {
  assert(f.ad_name.startsWith('qa_'), 'Use only a generated QA employee');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  admin = await browser.newContext({ ignoreHTTPSErrors: true });
  await api(admin, '/auth/sign-in/email', 'POST', { email: 'admin@assay.test', password: adminPassword });
  const snapshot = await api(admin, '/samba/snapshot'); assert.equal(snapshot.domain.toLowerCase(), 'dc=assay,dc=test');
  const companyLogin = snapshot.bindings.some(b => b.userId === f.assay_user_id && b.directoryManaged);
  employee = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  if (companyLogin) {
    const login = await api(employee, '/auth/sign-in/directory', 'POST', { username: f.ad_name, password: f.ad_password });
    assert.equal(login.filesConnected, true);
  } else {
    await api(employee, '/auth/sign-in/email', 'POST', { email: f.assay_email, password: f.assay_password });
    await api(employee, '/files/session', 'POST', { password: f.ad_password }, 201);
  }
  const status = await api(employee, '/files/status'); assert(status.connected && status.shares.includes(f.share));
  page = await employee.newPage();
  await page.addInitScript(() => { localStorage.setItem('i18nextLng', 'zh-CN'); localStorage.removeItem('assay:files:view'); });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let listRequests = 0; page.on('request', r => { if (new URL(r.url()).pathname === '/api/files/list') listRequests++; });
  await page.goto(origin + '/files');
  const root = () => page.getByRole('region', { name: '共享目录浏览器', exact: true });
  const files = () => page.getByRole('region', { name: '文件浏览器', exact: true });
  await root().waitFor();
  assert.equal(await page.getByRole('combobox').count(), 0);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.equal(listRequests, 0, 'Root must not select a share or eagerly enumerate all its files');
  const shown = [];
  do {
    shown.push(...await root().getByRole('button', { name: /^打开文件夹：/ }).evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label').slice('打开文件夹：'.length))));
    const next = root().getByRole('button', { name: '下一页', exact: true });
    if (!await next.count() || await next.isDisabled()) break;
    await next.click();
  } while (true);
  assert.deepEqual([...shown].sort(), [...status.shares].sort());
  pass('Root directly shows exactly the shares admitted for the employee, without a selector or eager file requests');
  const denied = snapshot.shares.find(s => s.active && !status.shares.includes(s.name));
  if (denied) await api(employee, '/files/list?' + new URLSearchParams({ share: denied.name, path: '' }), 'GET', undefined, 403);
  assert.equal(await page.getByRole('link', { name: '员工账号', exact: true }).count(), 0);
  pass('Employee file navigation does not expose directory administration or bypass share authorization');

  await page.getByRole('searchbox', { name: '搜索共享目录', exact: true }).fill(f.share);
  assert.equal(await root().getByRole('button', { name: '打开文件夹：' + f.share, exact: true }).count(), 1);
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.screenshot({ path: dir + '/file-manager-shares-desktop.png', fullPage: true });
  await page.getByRole('searchbox', { name: '搜索共享目录', exact: true }).fill(f.share);
  await root().getByRole('button', { name: '打开文件夹：' + f.share, exact: true }).click();
  await files().waitFor();
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByRole('dialog').getByLabel('文件夹名称', { exact: true }).fill(folder);
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await files().getByRole('button', { name: '打开文件夹：' + folder, exact: true }).waitFor(); created = true;
  await files().getByRole('button', { name: '打开文件夹：' + folder, exact: true }).click();
  await files().getByRole('heading', { name: '此文件夹为空', exact: true }).waitFor();
  pass('Search, folder cards, breadcrumbs and empty-folder state navigate the real SMB share');

  const name = '项目说明-中文.txt'; const bytes = Buffer.from('File manager upload/download verification\n中文员工文件\n');
  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  await page.getByText('已上传 ' + name, { exact: true }).waitFor();
  await files().getByRole('button', { name: '更多操作：' + name, exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('group', { name: name + ' 的操作', exact: true }).getByRole('link', { name: '下载', exact: true }).click();
  const download = await downloadEvent; assert.deepEqual(fs.readFileSync(await download.path()), bytes);
  pass('Grid upload and action-menu download transfer the exact employee file bytes');

  await files().getByRole('button', { name: '更多操作：' + name, exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('group', { name: name + ' 的操作', exact: true }).count(), 0);
  assert.equal(await files().getByRole('button', { name: '更多操作：' + name, exact: true }).evaluate(n => n === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('group', { name: name + ' 的操作', exact: true }).getByRole('button', { name: '移动 / 重命名', exact: true }).click();
  const renamed = '员工说明-重命名.txt';
  await page.getByRole('dialog').getByLabel('目标路径', { exact: true }).fill(folder + '/' + renamed);
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await files().getByRole('button', { name: '下载文件：' + renamed, exact: true }).waitFor();
  pass('Keyboard menu dismissal restores focus; rename uses the employee SMB session');

  await command({ action: 'mkdir', path: folder + '/项目资料' });
  await put(folder + '/外部保存.csv', 'team,amount\nengineering,8\n');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await files().getByRole('button', { name: '下载文件：外部保存.csv', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: '搜索当前文件夹', exact: true }).fill('无匹配的名称');
  await files().getByRole('heading', { name: '没有匹配的结果', exact: true }).waitFor();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  pass('Refresh reads externally saved shared files; search distinguishes no matches from an empty directory');

  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const table = files().getByRole('table', { name: '文件', exact: true }); await table.waitFor();
  const first = await table.getByRole('row').nth(1).getByRole('button', { name: /^打开文件夹：/ }).getAttribute('aria-label');
  assert.equal(first, '打开文件夹：项目资料');
  await table.getByRole('button', { name: /修改时间/ }).click();
  assert.equal(await table.getByRole('columnheader').nth(1).getAttribute('aria-sort'), 'descending');
  await table.getByRole('button', { name: /大小/ }).click();
  assert.equal(await table.getByRole('columnheader').nth(2).getAttribute('aria-sort'), 'ascending');
  const directEvent = page.waitForEvent('download'); await table.getByRole('button', { name: '下载文件：' + renamed, exact: true }).click();
  assert.deepEqual(fs.readFileSync(await (await directEvent).path()), bytes);
  pass('List view sorts by time and size while keeping folders first; opening a file downloads it');
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
  await page.screenshot({ path: dir + '/file-manager-grid-desktop.png', fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: dir + '/file-manager-grid-dark.png', fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await files().getByRole('button', { name: '更多操作：' + renamed, exact: true }).click();
  const menu = await page.getByRole('group', { name: renamed + ' 的操作', exact: true }).boundingBox();
  assert(menu && menu.x >= 0 && menu.x + menu.width <= 390 && menu.y >= 0 && menu.y + menu.height <= 844);
  await page.screenshot({ path: dir + '/file-manager-grid-mobile.png', fullPage: true });
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '列表视图', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: dir + '/file-manager-list-mobile.png', fullPage: true });
  pass('Grid, list and file action menus fit a 390px phone; dark mode uses local SVG icons');

  await page.getByRole('button', { name: '返回上一级', exact: true }).click();
  await files().getByRole('table', { name: '文件', exact: true }).waitFor();
  await page.getByRole('navigation', { name: '文件路径', exact: true }).getByRole('button', { name: '所有共享目录', exact: true }).click();
  await root().getByRole('table', { name: '共享目录', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '返回上一级', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  pass('Back and root breadcrumbs return to shared folders and retain the chosen layout');

  await page.getByRole('searchbox', { name: '搜索共享目录', exact: true }).fill(f.share);
  await root().getByRole('button', { name: '打开文件夹：' + f.share, exact: true }).click();
  await files().getByRole('button', { name: '打开文件夹：' + folder, exact: true }).click();
  await files().getByRole('button', { name: '更多操作：' + renamed, exact: true }).click();
  await page.getByRole('group', { name: renamed + ' 的操作', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await files().getByRole('button', { name: '下载文件：' + renamed, exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await api(employee, '/files/list?' + new URLSearchParams({ share: f.share, path: folder }))).entries.some(e => e.name === renamed), false);
  assert.deepEqual(errors, []);
  pass('Confirmed delete removes the real file and refreshes the UI without browser errors');
  await cleanup();
  pass('All generated file-manager QA files and folders are removed; existing employee files remain untouched');
  fs.writeFileSync(dir + '/file-browser-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(async error => { if (page) { await page.screenshot({ path: dir + '/file-manager-failure.png', fullPage: true }).catch(() => {}); console.error('Failed page path: ' + new URL(page.url()).pathname); } let message = error.message; for (const secret of [adminPassword, f.ad_password, f.assay_password]) if (secret) message = message.replaceAll(secret, '[redacted]'); console.error(message); process.exitCode = 1; }).finally(async () => {
  try { await cleanup(); } catch { console.error('QA folder cleanup requires follow-up: ' + folder); process.exitCode = 1; }
  for (const context of [employee, admin]) { try { if (context) await api(context, '/auth/sign-out', 'POST', {}); } catch {} }
  await browser?.close();
});
