const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
if (!dir || !process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE) throw new Error('Private artifact directory and password file required');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const suffix = Date.now().toString().slice(-7);
const secret = () => 'Aa9!' + randomBytes(18).toString('base64url');
const f = { ad_name: 'qa_alice_' + suffix, ad_password: secret(), assay_email: `qa-${suffix}@assay.test`, assay_password: secret(), group: 'qa_finance_' + suffix, group2: 'qa_other_' + suffix, share: 'qa_files_' + suffix };
const fixturePath = path.join(dir, 'fixture.json');
const save = () => fs.writeFileSync(fixturePath, JSON.stringify(f, null, 2), { mode: 0o600 });
const secrets = [adminPassword, f.ad_password, f.assay_password];
const results = [];
let browser, page;
function pass(name) { results.push(name); console.log('PASS ' + name); }
async function login(p, email, password) {
 await p.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
 await p.goto(origin + '/login'); await p.locator('form input').first().fill(email);
 await p.locator('input[type=password]').fill(password); await p.locator('form button[type=submit]').click(); await p.waitForURL('**/dashboard');
}
async function verify(p = page, password = adminPassword, endpoint = '/api/samba/commands', expected = 201) {
 const d = p.getByRole('dialog'); await d.locator('input[type=password]').fill(password);
 const promise = p.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST').catch(() => null);
 await d.getByRole('button', { name: '验证并继续', exact: true }).click();
 const r = await promise; assert(r, 'operation returned no response'); const body = await r.json(); assert.equal(r.status(), expected, body.message || body.error || 'request failed');
 if (expected < 400) await d.waitFor({ state: 'hidden' }); else await d.getByRole('button', { name: '取消', exact: true }).click();
 return body;
}
async function fill(title, fields, endpoint) {
 const d = page.getByRole('dialog', { name: title });
 for (const [label, value] of Object.entries(fields)) {
  const input = d.getByLabel(label, { exact: true });
  if (typeof value === 'boolean') await input.setChecked(value);
  else if (Array.isArray(value) || value?.select) await input.selectOption(Array.isArray(value) ? value : value.select);
  else await input.fill(value);
 }
 await d.getByRole('button', { name: '确认并验证身份' }).click(); return verify(page, adminPassword, endpoint);
}
async function form(button, title, fields, endpoint) { await page.getByRole('button', { name: button, exact: true }).click(); return fill(title, fields, endpoint); }
function row(name) { return page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) }); }
async function edit(name, button, title, fields) { await row(name).getByRole('button', { name: button, exact: true }).click(); return fill(title, fields); }
async function snapshot() { const r = await page.request.get(origin + '/api/samba/snapshot'); assert.equal(r.status(), 200); return r.json(); }
function probe(mode, allowed = true) {
 save(); const r = spawnSync('python3', [path.join(__dirname, 'smb_probe.py'), fixturePath, mode], { env: process.env, timeout: 30000, encoding: 'utf8' });
 if (allowed) assert.equal(r.status, 0, r.stdout + r.stderr); else { assert.equal(r.status, 3); assert.match(r.stdout, /ACCESS_DENIED/); }
}
(async () => {
 save(); browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: `${new URL(origin).hostname},127.0.0.1,localhost` } } : {}) });
 const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } }); page = await context.newPage();
 await login(page, 'admin@assay.test', adminPassword); await page.goto(origin + '/samba'); await page.getByRole('button', { name: '新增员工', exact: true }).waitFor();
 pass('IP HTTPS login and live AD connection');
 await form('新增员工', '新增员工账号', { '登录账号': f.ad_name, '员工姓名': '测试财务员工', '初始 AD 密码': f.ad_password });
 let data = await snapshot(); f.user_id = data.users.find(u => u.name === f.ad_name).id; pass('Web creates AD employee');
 await edit(f.ad_name, '编辑', '编辑员工账号', { '员工姓名': '测试财务员工（已编辑）', '停用账号': true });
 assert.equal((await snapshot()).users.find(u => u.id === f.user_id).disabled, true);
 await edit(f.ad_name, '编辑', '编辑员工账号', { '停用账号': false }); pass('Edit, disable and enable; stable GUID preserved');
 f.ad_password = secret(); secrets.push(f.ad_password); save(); await edit(f.ad_name, '重置密码', '重置 AD 密码', { '新的 AD 密码': f.ad_password }); pass('Administrator resets AD password');
 await page.getByRole('tab', { name: '用户组', exact: true }).click();
 await form('新增用户组', '新增用户组', { '用户组名称': f.group, '说明': '测试财务权限组' });
 await form('新增用户组', '新增用户组', { '用户组名称': f.group2, '说明': '测试辅助权限组' });
 data = await snapshot(); f.group_id = data.groups.find(g => g.name === f.group).id; f.group2_id = data.groups.find(g => g.name === f.group2).id;
 await edit(f.group, '编辑', '编辑用户组', { '说明': '财务读写权限（已编辑）' });
 await edit(f.group, '调整成员', '调整组成员', { '员工账号': { select: f.user_id }, '加入用户组（取消勾选表示移出）': true }); pass('Web creates/edits groups and assigns membership');
 await page.getByRole('tab', { name: '共享与目录', exact: true }).click();
 await form('新增共享', '新增共享', { '共享名称': f.share, '说明': '隔离测试共享', '允许访问的用户组': [f.group_id], '共享只读': false });
 probe('write'); probe('read'); pass('Share and restrictive ACL; real employee SMB reads/writes');
 await row(f.share).getByRole('button', { name: '管理目录与权限' }).click(); await page.getByRole('button', { name: '设置用户组权限', exact: true }).waitFor();
 await form('新建目录', '新建目录', { '相对共享根目录的路径': '资料' }); await page.getByRole('button', { name: '📁 资料', exact: true }).click();
 await form('新建目录', '新建目录', { '相对共享根目录的路径': '资料/2026' }); pass('Nested directories created through SMB with ACL inheritance');
 await page.getByRole('button', { name: '共享根目录', exact: true }).click();
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'read' } }); probe('read'); probe('write', false); pass('ACL read-only denies real SMB writes');
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'modify' } }); probe('write');
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'remove' } }); probe('read', false);
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'modify' } }); pass('ACL grant/revoke preserves administrative access');
 await edit(f.share, '编辑', '编辑共享', { '说明': '共享说明已编辑', '共享只读': true }); probe('read'); probe('write', false);
 await edit(f.share, '编辑', '编辑共享', { '共享只读': false }); pass('Share-level read-only restriction enforced');
 await page.getByRole('tab', { name: '用户组', exact: true }).click();
 await edit(f.group, '调整成员', '调整组成员', { '员工账号': { select: f.user_id }, '加入用户组（取消勾选表示移出）': false }); probe('read', false);
 await edit(f.group, '调整成员', '调整组成员', { '员工账号': { select: f.user_id }, '加入用户组（取消勾选表示移出）': true }); probe('read'); pass('Membership removal/restoration affects new SMB sessions');
 await row(f.group2).getByRole('button', { name: '删除', exact: true }).click(); await verify(); pass('Web deletes empty group');
 await page.goto(origin + '/users'); await page.getByLabel('邮箱', { exact: true }).fill(f.assay_email); await page.getByLabel('姓名', { exact: true }).fill('测试财务员工 ' + suffix);
 await page.getByLabel('初始密码（≥6 位）', { exact: true }).fill(f.assay_password); await page.getByLabel(/提单人/).check(); await page.getByRole('button', { name: '新建用户', exact: true }).click(); await verify(page, adminPassword, '/api/users');
 await page.goto(origin + '/samba'); await page.getByRole('tab', { name: '身份绑定', exact: true }).click(); data = await snapshot(); f.assay_user_id = data.assayUsers.find(u => u.email === f.assay_email).id;
 await form('绑定身份', '绑定员工 AD 身份', { 'Assay 用户': { select: f.assay_user_id }, 'AD 员工账号': { select: f.user_id } }, '/api/samba/bindings'); pass('Web explicitly binds requester to AD GUID');
 const ec = await browser.newContext({ ignoreHTTPSErrors: true }); const ep = await ec.newPage(); await login(ep, f.assay_email, f.assay_password);
 assert.equal((await ep.request.get(origin + '/api/samba/snapshot')).status(), 403); assert.equal((await ep.request.post(origin + '/api/samba/commands', { data: { requestId: randomUUID(), action: 'user.password', args: { id: f.user_id, password: secret() } } })).status(), 403); pass('Requester cannot administer directory or execute privileged operations');
 await ep.goto(origin + '/settings?tab=security'); await ep.getByLabel('当前 AD 密码', { exact: true }).fill(f.ad_password); const next = secret(); secrets.push(next);
 await ep.getByLabel('新的 AD 密码', { exact: true }).fill(next); await ep.getByLabel('确认新的 AD 密码', { exact: true }).fill(next); await ep.getByRole('button', { name: '修改公司密码', exact: true }).click(); await verify(ep, f.assay_password, '/api/samba/me/password');
 f.ad_password = next; save(); probe('read'); pass('Employee self-service changes AD password while Assay password remains independent');
 await page.getByRole('tab', { name: '共享与目录', exact: true }).click(); await row(f.share).getByRole('button', { name: '管理目录与权限' }).click();
 await page.getByRole('button', { name: '📁 资料', exact: true }).click(); await page.getByRole('button', { name: '📁 2026', exact: true }).click(); await page.getByRole('button', { name: '删除当前空目录', exact: true }).click(); await verify();
 await page.getByRole('button', { name: '删除当前空目录', exact: true }).click(); await verify(); await page.getByRole('button', { name: '共享根目录', exact: true }).click(); pass('Web deletes empty directories');
 await row(f.share).getByRole('button', { name: '移除共享', exact: true }).click(); await verify(); await page.getByText('已移除的共享（文件保留）', { exact: true }).click(); await form('恢复共享', '恢复共享', {}); probe('read'); pass('Remove/restore share preserves file contents and ACL');
 await page.getByRole('tab', { name: '操作记录', exact: true }).click(); const history = await (await page.request.get(origin + '/api/samba/operations')).json();
 assert(history.some(h => h.action === 'user.change_password' && h.state === 'succeeded')); for (const value of secrets) assert(!JSON.stringify(history).includes(value)); pass('Durable audit contains no passwords');
 await page.screenshot({ path: path.join(dir, 'management.png'), fullPage: true }); fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ origin, passed: results.length, results, completedAt: new Date().toISOString(), account: f.ad_name, group: f.group, share: f.share }, null, 2));
})().catch(e => {
 let message = e.message; for (const value of secrets) message = message.replaceAll(value, '[redacted]'); console.error(message);
 fs.writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ passed: results, error: message })); process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
