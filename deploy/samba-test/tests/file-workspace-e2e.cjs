const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const f = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const headers = { Origin: origin };
const folder = 'qa-file-workspace-' + Date.now();
const results = [];
let browser, employee, page, created = false;
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
  for (const entry of listing.entries) {
    if (entry.directory) {
      const nested = await api(employee, '/files/list?' + new URLSearchParams({ share: f.share, path: folder + '/' + entry.name }));
      for (const child of nested.entries) await command({ action: 'delete', path: folder + '/' + entry.name + '/' + child.name });
    }
    await command({ action: 'delete', path: folder + '/' + entry.name });
  }
  await command({ action: 'delete', path: folder }); created = false;
}
(async () => {
  assert(f.ad_name.startsWith('qa_'), 'Use only a generated QA employee');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',127.0.0.1,localhost' } } : {}) });
  employee = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const login = await api(employee, '/auth/sign-in/directory', 'POST', { username: f.ad_name, password: f.ad_password });
  assert.equal(login.filesConnected, true);
  const status = await api(employee, '/files/status'); assert(status.connected && status.shares.includes(f.share));
  await command({ action: 'mkdir', path: folder }); created = true;
  page = await employee.newPage();
  await page.addInitScript(() => { localStorage.setItem('i18nextLng', 'zh-CN'); localStorage.removeItem('assay:files:view'); });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/files');
  const files = () => page.getByRole('region', { name: '文件浏览器', exact: true });
  const tasks = () => page.getByRole('region', { name: '上传任务', exact: true });
  const enter = async name => { await files().getByRole('button', { name: '打开文件夹：' + name, exact: true }).click(); };
  const choose = async name => files().getByRole('checkbox', { name: '选择：' + name, exact: true }).check();
  const uploadFiles = async names => {
    await page.getByLabel('选择上传文件', { exact: true }).setInputFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from('employee-content:' + name) })));
    for (const name of names) await tasks().getByRole('listitem', { name: '上传：' + name, exact: true }).getByText('上传完成', { exact: true }).waitFor();
    await files().getByRole('button', { name: '下载文件：' + names.at(-1), exact: true }).waitFor();
  };
  const read = async path => {
    const response = await employee.request.get(fileURL(folder + '/' + path));
    assert.equal(response.status(), 200); return (await response.body()).toString();
  };
  const clear = async () => page.getByRole('button', { name: '清除已结束任务', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索共享目录', exact: true }).fill(f.share);
  await page.getByRole('button', { name: '打开文件夹：' + f.share, exact: true }).click();
  await enter(folder);
  await uploadFiles(['a.txt', '中文说明.txt']);
  assert.equal(await read('a.txt'), 'employee-content:a.txt');
  assert.equal(await read('中文说明.txt'), 'employee-content:中文说明.txt');
  pass('Multiple file picker uploads preserve exact bytes through the employee SMB session');
  await clear();

  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('must-not-overwrite') },
    { name: 'after-conflict.txt', mimeType: 'text/plain', buffer: Buffer.from('next-upload') },
  ]);
  await tasks().getByRole('listitem', { name: '上传：a.txt', exact: true }).getByText(/上传失败/).waitFor();
  await tasks().getByRole('listitem', { name: '上传：after-conflict.txt', exact: true }).getByText('上传完成', { exact: true }).waitFor();
  assert.equal(await read('a.txt'), 'employee-content:a.txt'); assert.equal(await read('after-conflict.txt'), 'next-upload');
  pass('An existing filename is not overwritten and its failure does not discard the next queued upload');
  await clear();

  const drop = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['drag-one'], 'drag-one.txt', { type: 'text/plain' }));
    transfer.items.add(new File(['drag-two'], 'drag-two.txt', { type: 'text/plain' }));
    return transfer;
  });
  await files().dispatchEvent('drop', { dataTransfer: drop }); await drop.dispose();
  for (const name of ['drag-one.txt', 'drag-two.txt']) await tasks().getByRole('listitem', { name: '上传：' + name, exact: true }).getByText('上传完成', { exact: true }).waitFor();
  assert.equal(await read('drag-one.txt'), 'drag-one'); assert.equal(await read('drag-two.txt'), 'drag-two');
  pass('Dropping multiple files uploads to the open folder without navigating the browser');
  await clear();

  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/files/content?*', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'PUT' && url.searchParams.get('path') === folder + '/held.txt') {
      held = true; await gate;
    }
    await route.continue().catch(() => {});
  });
  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles(['held.txt', 'cancel-queued.txt', 'last.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
  await tasks().getByRole('button', { name: '取消上传：cancel-queued.txt', exact: true }).click();
  await page.getByRole('button', { name: '返回上一级', exact: true }).click();
  await files().getByRole('button', { name: '打开文件夹：' + folder, exact: true }).waitFor();
  assert(held); release();
  for (const name of ['held.txt', 'last.txt']) await tasks().getByRole('listitem', { name: '上传：' + name, exact: true }).getByText('上传完成', { exact: true }).waitFor();
  assert.equal(await read('last.txt'), 'last.txt');
  const parent = await api(employee, '/files/list?' + new URLSearchParams({ share: f.share, path: '' }));
  assert(!parent.entries.some(e => ['held.txt', 'last.txt'].includes(e.name)));
  const listing = await api(employee, '/files/list?' + new URLSearchParams({ share: f.share, path: folder }));
  assert(!listing.entries.some(e => e.name === 'cancel-queued.txt'));
  await page.unrouteAll({ behavior: 'wait' });
  pass('Cancelling a queued upload sends no bytes; navigating during upload retains the original destination');
  await clear(); await enter(folder);

  let releaseCancelled;
  const cancelledGate = new Promise(resolve => { releaseCancelled = resolve; });
  await page.route('**/api/files/content?*', async route => {
    if (route.request().method() === 'PUT' && new URL(route.request().url()).searchParams.get('path') === folder + '/cancel-active.txt') {
      await cancelledGate; await route.abort().catch(() => {});
    } else await route.continue();
  });
  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles(['cancel-active.txt', 'after-cancel.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
  await tasks().getByRole('button', { name: '取消上传：cancel-active.txt', exact: true }).click();
  await tasks().getByRole('listitem', { name: '上传：after-cancel.txt', exact: true }).getByText('上传完成', { exact: true }).waitFor();
  releaseCancelled(); await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await read('after-cancel.txt'), 'after-cancel.txt');
  pass('Cancelling an in-flight request releases the queue and continues the remaining uploads');
  await clear();

  await command({ action: 'mkdir', path: folder + '/target' });
  await put(folder + '/target/a.txt', 'existing-target');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await choose('a.txt'); await choose('中文说明.txt');
  await page.getByRole('button', { name: '移动所选', exact: true }).click();
  await page.getByRole('dialog').getByLabel('目标文件夹路径', { exact: true }).fill('../outside');
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').waitFor();
  assert.match(await page.getByRole('dialog').getByRole('alert').textContent(), /相对文件夹路径/);
  await page.getByRole('dialog').getByLabel('目标文件夹路径', { exact: true }).fill(folder + '/target');
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  const resultRegion = () => page.getByRole('region', { name: '批量操作结果', exact: true });
  await resultRegion().getByRole('heading', { name: '批量操作结果：1 项成功，1 项失败或未执行', exact: true }).waitFor();
  assert.equal(await read('target/a.txt'), 'existing-target');
  assert.equal(await read('target/中文说明.txt'), 'employee-content:中文说明.txt');
  assert.equal(await read('a.txt'), 'employee-content:a.txt');
  pass('Batch move reports partial completion and never overwrites existing destination files');

  await files().getByRole('checkbox', { name: '选择：a.txt', exact: true }).waitFor();
  await choose('target'); await choose('a.txt');
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await resultRegion().getByRole('heading', { name: '批量操作结果：1 项成功，1 项失败或未执行', exact: true }).waitFor();
  await files().getByRole('button', { name: '下载文件：a.txt', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await read('target/a.txt'), 'existing-target');
  pass('Batch delete removes individual files but preserves nonempty folders and their children');

  await choose('target'); await page.getByRole('searchbox', { name: '搜索当前文件夹', exact: true }).fill('after');
  assert.equal(await page.getByRole('button', { name: '删除所选', exact: true }).count(), 0);
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await choose('target');
  await files().getByRole('button', { name: /^名称/ }).click();
  assert.equal(await page.getByRole('button', { name: '删除所选', exact: true }).count(), 0);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const checkbox = files().getByRole('checkbox', { name: '选择：target', exact: true });
  await checkbox.focus(); await page.keyboard.press('Space'); assert.equal(await checkbox.isChecked(), true);
  await page.keyboard.press('Escape'); assert.equal(await checkbox.isChecked(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await choose('target');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: dir + '/file-workspace-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '网格视图', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: dir + '/file-workspace-desktop.png', fullPage: true });
  pass('Selection clears when filtering or sorting, works by keyboard in list view, and fits the mobile layout');
  // The browser cannot construct a native directory drag from File objects. Model that
  // read-only DragEvent entry explicitly; real file drag/upload paths are tested above.
  await files().evaluate(element => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: {
      types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }],
    } });
    element.dispatchEvent(event);
  });
  await page.getByText('暂不支持拖入整个文件夹，请选择文件上传。', { exact: true }).waitFor();
  const afterDrop = await api(employee, '/files/list?' + new URLSearchParams({ share: f.share, path: folder }));
  assert(!afterDrop.entries.some(e => e.name === 'folder-drop'));
  pass('Unsupported directory drops explain the limitation without creating an empty placeholder file');
  assert.equal(await page.locator('input[type=password]').count(), 0); assert.deepEqual(errors, []);
  await cleanup(); pass('Only generated QA files were modified and all test files were cleaned up');
  fs.writeFileSync(dir + '/file-workspace-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(async error => {
  if (page) await page.screenshot({ path: dir + '/file-workspace-failure.png', fullPage: true }).catch(() => {});
  let message = error.message; for (const secret of [f.ad_password, f.assay_password]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}).finally(async () => {
  // Release intercepted requests before closing the browser, even after an assertion failure.
  await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  try { await cleanup(); } catch { console.error('QA folder cleanup requires follow-up: ' + folder); process.exitCode = 1; }
  try { if (employee) await api(employee, '/auth/sign-out', 'POST', {}); } catch {}
  await browser?.close();
});
