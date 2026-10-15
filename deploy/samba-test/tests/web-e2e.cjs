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
  else if (Array.isArray(value)) { const boxes = d.getByRole('group', { name: label, exact: true }).locator('input[type=checkbox]'); for (const box of await boxes.all()) await box.setChecked(value.includes(await box.getAttribute('value'))); }
  else if (value?.select) await input.selectOption(value.select);
  else await input.fill(value);
 }
 await d.getByRole('button', { name: '确认并验证身份' }).click(); return verify(page, adminPassword, endpoint);
}
async function form(button, title, fields, endpoint) { await page.getByRole('button', { name: button, exact: true }).click(); return fill(title, fields, endpoint); }
async function detail(section, id) { await page.goto(origin + '/samba/' + section + '/' + id); await page.getByRole('heading', { name: /详情$/, level: 1 }).waitFor(); }
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
 await form('新增员工', '新增员工账号', { '登录账号': f.ad_name, '员工姓名': '测试财务员工', '工号': 'GS' + suffix, '邮箱': f.ad_name + '@assay.test', '部门': '财务部', '岗位': '会计', '电话': '010-12345678', '公司': 'GreenStor', '办公地点': '总部', '初始 AD 密码': f.ad_password });
 let data = await snapshot(); f.user_id = data.users.find(u => u.name === f.ad_name).id; assert.equal(data.users.find(u => u.id === f.user_id).employeeId, 'GS' + suffix); assert.equal(data.users.find(u => u.id === f.user_id).department, '财务部'); pass('Web creates AD employee with standard profile attributes');
 f.ad2_name = 'qa_bob_' + suffix; await form('新增员工', '新增员工账号', { '登录账号': f.ad2_name, '员工姓名': '测试财务同事', '初始 AD 密码': f.ad_password }); f.user2_id = (await snapshot()).users.find(u => u.name === f.ad2_name).id;
 await detail('users', f.user_id); await form('编辑员工资料', '编辑员工资料', { '员工姓名': '测试财务员工（已编辑）', '岗位': '财务主管', '邮箱': '', '停用账号': true });
 data = await snapshot(); assert.equal(data.users.find(u => u.id === f.user_id).disabled, true); assert.equal(data.users.find(u => u.id === f.user_id).email, ''); assert.equal(data.users.find(u => u.id === f.user_id).title, '财务主管'); pass('Employee detail edits and explicitly clears optional profile fields');
 await form('编辑员工资料', '编辑员工资料', { '停用账号': false }); pass('Edit, disable and enable; stable GUID preserved');
 f.ad_password = secret(); secrets.push(f.ad_password); save(); await form('重置密码', '重置 AD 密码', { '新的 AD 密码': f.ad_password }); pass('Administrator resets AD password');
 await page.goto(origin + '/samba/groups');
 await form('新增用户组', '新增用户组', { '用户组名称': f.group, '说明': '测试财务权限组' });
 await form('新增用户组', '新增用户组', { '用户组名称': f.group2, '说明': '测试辅助权限组' });
 data = await snapshot(); f.group_id = data.groups.find(g => g.name === f.group).id; f.group2_id = data.groups.find(g => g.name === f.group2).id;
 await detail('groups', f.group_id); await form('编辑用户组', '编辑用户组', { '说明': '财务读写权限（已编辑）' });
 await form('添加成员', '添加组成员', { '选择员工': [f.user_id, f.user2_id] }); assert.equal((await snapshot()).groups.find(g => g.id === f.group_id).members.length, 2); pass('Web multi-select adds multiple group members');
 await page.getByLabel('选择成员 ' + f.ad_name, { exact: true }).check(); await page.getByLabel('选择成员 ' + f.ad2_name, { exact: true }).check(); await page.getByRole('button', { name: '移出所选成员', exact: true }).click(); await verify(); assert.equal((await snapshot()).groups.find(g => g.id === f.group_id).members.length, 0); pass('Web batch removal changes membership without deleting employees');
 await form('添加成员', '添加组成员', { '选择员工': [f.user_id, f.user2_id] }); await page.getByRole('table', { name: '组成员', exact: true }).getByRole('row').filter({ hasText: f.ad2_name }).getByRole('button', { name: '移出成员', exact: true }).click(); await verify(); assert.equal((await snapshot()).groups.find(g => g.id === f.group_id).members.length, 1); assert(await page.getByRole('button', { name: '删除用户组', exact: true }).isDisabled()); await page.getByText('请先移出全部成员，再删除用户组。', { exact: true }).waitFor(); pass('Single-member removal and visible group-deletion reason');
 await page.goto(origin + '/samba/shares');
 await form('新增目录', '新增共享目录', { '目录名称': f.share, '说明': '隔离测试共享', '允许访问的用户组': [f.group_id], '共享只读': false });
 probe('write'); probe('read'); pass('Share and restrictive ACL; real employee SMB reads/writes');
 await detail('shares', f.share); await page.getByRole('button', { name: '设置用户组权限', exact: true }).waitFor();
 await form('新建目录', '新建目录', { '相对共享根目录的路径': '资料' }); await page.getByRole('button', { name: '资料', exact: true }).click();
 await form('新建目录', '新建目录', { '相对共享根目录的路径': '资料/2026' }); pass('Nested directories created through SMB with ACL inheritance');
 await page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: f.share, exact: true }).click();
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'read' } }); probe('read'); probe('write', false); pass('ACL read-only denies real SMB writes');
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'modify' } }); probe('write');
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'remove' } }); probe('read', false);
 await form('设置用户组权限', '设置用户组目录权限', { '用户组': { select: f.group_id }, '访问权限': { select: 'modify' } }); pass('ACL grant/revoke preserves administrative access');
 await form('编辑共享目录', '编辑共享目录', { '说明': '共享说明已编辑', '共享只读': true }); probe('read'); probe('write', false);
 await form('编辑共享目录', '编辑共享目录', { '共享只读': false }); pass('Share-level read-only restriction enforced');
 await page.goto(origin + '/samba/groups');
 await detail('groups', f.group_id); await page.getByRole('button', { name: '移出成员', exact: true }).click(); await verify(); probe('read', false);
 await form('添加成员', '添加组成员', { '选择员工': [f.user_id] }); probe('read'); pass('Membership removal/restoration affects new SMB sessions');
 await detail('groups', f.group2_id); await page.getByRole('button', { name: '删除用户组', exact: true }).click(); await verify(); pass('Web deletes empty group');
 await page.goto(origin + '/users'); await page.getByLabel('邮箱', { exact: true }).fill(f.assay_email); await page.getByLabel('姓名', { exact: true }).fill('测试财务员工 ' + suffix);
 await page.getByLabel('初始密码（≥6 位）', { exact: true }).fill(f.assay_password); await page.getByLabel(/提单人/).check(); await page.getByRole('button', { name: '新建用户', exact: true }).click(); await verify(page, adminPassword, '/api/users');
 await page.goto(origin + '/samba/bindings'); data = await snapshot(); f.assay_user_id = data.assayUsers.find(u => u.email === f.assay_email).id;
 await form('关联账号', '关联员工登录账号', { 'Assay 用户': { select: f.assay_user_id }, 'AD 员工账号': { select: f.user_id } }, '/api/samba/bindings'); pass('Web explicitly binds requester to AD GUID');
 const ec = await browser.newContext({ ignoreHTTPSErrors: true }); const ep = await ec.newPage(); await login(ep, f.assay_email, f.assay_password);
 assert.equal((await ep.request.get(origin + '/api/samba/snapshot')).status(), 403); assert.equal((await ep.request.post(origin + '/api/samba/commands', { data: { requestId: randomUUID(), action: 'user.password', args: { id: f.user_id, password: secret() } } })).status(), 403); pass('Requester cannot administer directory or execute privileged operations');
 await ep.goto(origin + '/settings?tab=security'); await ep.getByLabel('当前 AD 密码', { exact: true }).fill(f.ad_password); const next = secret(); secrets.push(next);
 await ep.getByLabel('新的 AD 密码', { exact: true }).fill(next); await ep.getByLabel('确认新的 AD 密码', { exact: true }).fill(next); await ep.getByRole('button', { name: '修改公司密码', exact: true }).click(); await verify(ep, f.assay_password, '/api/samba/me/password');
 f.ad_password = next; save(); probe('read'); pass('Employee self-service changes AD password while Assay password remains independent');
 await page.goto(origin + '/samba/shares'); await detail('shares', f.share);
 await page.getByRole('button', { name: '资料', exact: true }).click(); await page.getByRole('button', { name: '2026', exact: true }).click(); await page.getByRole('button', { name: '删除当前空目录', exact: true }).click(); await verify();
 await page.getByRole('button', { name: '删除当前空目录', exact: true }).click(); await verify(); await page.getByRole('navigation', { name: '目录路径' }).getByRole('button', { name: f.share, exact: true }).click(); pass('Web deletes empty directories');
 await page.getByRole('button', { name: '移除共享', exact: true }).click(); await verify(); await form('恢复共享目录', '恢复共享目录', {}); probe('read'); pass('Remove/restore share preserves file contents and ACL');
 await page.goto(origin + '/samba/history'); const history = await (await page.request.get(origin + '/api/samba/operations')).json();
 assert(history.some(h => h.action === 'user.change_password' && h.state === 'succeeded')); for (const value of secrets) assert(!JSON.stringify(history).includes(value)); pass('Durable audit contains no passwords');
 await page.screenshot({ path: path.join(dir, 'management.png'), fullPage: true }); fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ origin, passed: results.length, results, completedAt: new Date().toISOString(), account: f.ad_name, group: f.group, share: f.share }, null, 2));
})().catch(e => {
 let message = e.message; for (const value of secrets) message = message.replaceAll(value, '[redacted]'); console.error(message);
 fs.writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ passed: results, error: message })); process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
