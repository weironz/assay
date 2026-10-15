const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID, randomBytes } = require('node:crypto');
const { chromium } = require('playwright');
const origin = process.env.SAMBA_E2E_ORIGIN || 'https://100.70.220.77:8446';
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const password = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
const fixture = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const results = [];
const managerPassword = 'Aa9!' + randomBytes(20).toString('base64url');
let browser;
function pass(name) { results.push(name); console.log('PASS ' + name); }
async function login(page, email, pwd) {
 await page.addInitScript(() => localStorage.setItem('i18nextLng', 'zh-CN'));
 await page.goto(origin + '/login'); await page.locator('form input').first().fill(email);
 await page.locator('input[type=password]').fill(pwd); await page.locator('form button[type=submit]').click(); await page.waitForURL('**/dashboard');
}
async function token(page, purpose = 'samba', pwd = password) {
 const r = await page.request.post(origin + '/api/me/security/step-up', { data: { purpose, password: pwd } }); assert.equal(r.status(), 201); return (await r.json()).stepUpToken;
}
async function post(page, data, stepUp) { return page.request.post(origin + '/api/samba/commands', { data, headers: { Origin: origin, ...(stepUp ? { 'x-step-up-token': stepUp } : {}) } }); }
async function completed(page, id) {
 for (let i = 0; i < 100; i++) {
  const r = await page.request.get(origin + '/api/samba/operations/' + id); const v = await r.json();
  if (!['pending', 'queued', 'running'].includes(v.state)) return v;
  await page.waitForTimeout(100);
 }
 throw new Error('operation did not finish');
}
(async () => {
 browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: `${new URL(origin).hostname},127.0.0.1,localhost` } } : {}) });
 const c = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await c.newPage();
 assert.equal((await page.request.get(origin + '/api/samba/snapshot')).status(), 401); pass('Anonymous access denied');
 await login(page, 'admin@assay.test', password);
 const snapshot = await (await page.request.get(origin + '/api/samba/snapshot')).json();
 assert.equal(snapshot.domain.toLowerCase(), 'dc=assay,dc=test');
 const employeeBefore = snapshot.users.find(u => u.id === fixture.user_id);
 assert(employeeBefore && employeeBefore.name.startsWith('qa_'));
 const command = { requestId: randomUUID(), action: 'user.update', args: { id: fixture.user_id, display_name: '测试财务员工（已编辑）', disabled: false } };
 assert.equal((await post(page, command)).status(), 201); assert.equal((await completed(page, command.requestId)).state, 'succeeded');
 pass('An active global administrator manages AD without a step-up ticket');
 const employeeAfter = (await (await page.request.get(origin + '/api/samba/snapshot')).json()).users.find(u => u.id === fixture.user_id);
 for (const field of ['employeeId', 'email', 'department', 'title', 'phone', 'company', 'office']) assert.equal(employeeAfter[field], employeeBefore[field]);
 pass('Legacy profile omissions preserve existing employee attributes');
 const managerEmail = 'qa-manager-' + randomUUID() + '@assay.test';
 assert.equal((await page.request.post(origin + '/api/users', { headers: { Origin: origin }, data: { email: managerEmail, name: 'QA delegated directory manager', password: managerPassword, roleNames: ['samba_manager'] } })).status(), 201);
 const mc = await browser.newContext({ ignoreHTTPSErrors: true }); const mp = await mc.newPage(); await login(mp, managerEmail, managerPassword);
 const managedCommand = { ...command, requestId: randomUUID() };
 assert.equal((await post(mp, managedCommand)).status(), 403); pass('Delegated managers still require verification');
 assert.equal((await post(mp, managedCommand, await token(mp, 'roles', managerPassword))).status(), 403); pass('Delegated verification cannot cross purpose boundaries');
 const oneTime = await token(mp, 'samba', managerPassword);
 assert.equal((await post(mp, managedCommand, oneTime)).status(), 201); assert.equal((await completed(page, managedCommand.requestId)).state, 'succeeded');
 assert.equal((await post(mp, managedCommand, oneTime)).status(), 403); pass('Delegated managers use a proof only once');
 assert.equal((await post(page, command)).status(), 201);
 const history = await (await page.request.get(origin + '/api/samba/operations')).json(); assert.equal(history.filter(v => v.id === command.requestId).length, 1); pass('Repeated request ID does not execute another external write');
 assert.equal((await post(page, { ...command, args: { ...command.args, display_name: 'DIFFERENT' } })).status(), 409); pass('Request ID cannot be reused with different data');
 assert.equal((await post(page, { requestId: randomUUID(), action: 'exec', args: { command: 'id' } })).status(), 400); pass('No arbitrary command endpoint');
 assert.equal((await post(page, { requestId: randomUUID(), action: 'directory.create', args: { share: fixture.share, path: '../private' } })).status(), 400); pass('Path traversal rejected');
 const nonempty = { requestId: randomUUID(), action: 'group.delete', args: { id: fixture.group_id } };
 assert.equal((await post(page, nonempty)).status(), 201); assert.equal((await completed(page, nonempty.requestId)).state, 'failed'); pass('Nonempty groups cannot be deleted');
 const stale = { requestId: randomUUID(), action: 'acl.grant', args: { share: fixture.share, path: '', principal_id: fixture.group_id, group: true, mode: 'read', inherit: true, revision: '0'.repeat(64) } };
 const before = await (await page.request.get(origin + '/api/samba/acl?share=' + fixture.share + '&path=')).json();
 assert.equal((await post(page, stale)).status(), 201); assert.equal((await completed(page, stale.requestId)).state, 'failed');
 const after = await (await page.request.get(origin + '/api/samba/acl?share=' + fixture.share + '&path=')).json(); assert.equal(before.revision, after.revision); pass('Stale ACL version rejects overwrite before resource changes');
 const foreign = { requestId: randomUUID(), action: 'user.password', args: { id: '0'.repeat(32), password: 'Test-not-a-real-password123!' } };
 assert.equal((await post(page, foreign)).status(), 201); assert.equal((await completed(page, foreign.requestId)).state, 'failed'); pass('Objects outside managed scope cannot be modified');
 const groupBefore = (await (await page.request.get(origin + '/api/samba/snapshot')).json()).groups.find(g => g.id === fixture.group_id);
 for (const add of [true, false]) {
  const batch = { requestId: randomUUID(), action: 'group.members', args: { group_id: fixture.group_id, user_ids: [add ? fixture.user2_id : fixture.user_id, '0'.repeat(32)], add } };
  assert.equal((await post(page, batch)).status(), 201); assert.equal((await completed(page, batch.requestId)).state, 'failed');
  const groupAfter = (await (await page.request.get(origin + '/api/samba/snapshot')).json()).groups.find(g => g.id === fixture.group_id);
  assert.deepEqual(groupAfter.members, groupBefore.members);
 }
 pass('Batch membership validates all targets before modifying any member');
 assert.equal((await post(page, { requestId: randomUUID(), action: 'group.members', args: { group_id: fixture.group_id, user_ids: [fixture.user_id, fixture.user_id], add: true } })).status(), 400);
 pass('Duplicate batch members rejected before dispatch');
 const ec = await browser.newContext({ ignoreHTTPSErrors: true }); const ep = await ec.newPage(); await login(ep, fixture.assay_email, fixture.assay_password);
 assert.equal((await ep.request.get(origin + '/api/samba/me/operations/' + command.requestId)).status(), 403); pass('Employees cannot inspect another actor operation');
 const t = await token(ep, 'account', fixture.assay_password);
 assert.equal((await ep.request.post(origin + '/api/samba/me/password', { headers: { 'x-step-up-token': t }, data: { requestId: randomUUID(), old_password: fixture.ad_password, password: 'Test-not-a-real-password123!', id: '0'.repeat(32) } })).status(), 400); pass('Self-service cannot choose another AD identity');
 fs.writeFileSync(dir + '/security-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2));
})().catch(e => { let message = e.message; for (const s of [password, fixture.ad_password, fixture.assay_password, managerPassword]) message = message.replaceAll(s, '[redacted]'); console.error(message); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
