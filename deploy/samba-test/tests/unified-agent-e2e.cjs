// Existing generated QA employee only. Restore share metadata and remove all QA files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID, randomBytes } = require('node:crypto');
const { chromium } = require('playwright');
const origin = require('./test-origin.cjs');
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const f = JSON.parse(fs.readFileSync(dir + '/fixture.json', 'utf8'));
const adminPassword = fs.readFileSync(process.env.SAMBA_E2E_ADMIN_PASSWORD_FILE, 'utf8').trim();
let browser, admin, employee, original, shareArgs, restoreShare = false, folderCreated = false, fileCreated = false;
const folder = 'qa-unified-' + Date.now(), file = folder + '/stream.bin', results = [];
const pass = name => { results.push(name); console.log('PASS ' + name); };
async function api(context, path, method = 'GET', data, status = 200) {
  const r = await context.request.fetch(origin + '/api' + path, { method, headers: { Origin: origin }, ...(data === undefined ? {} : { data }) });
  assert.equal(r.status(), status, 'Unexpected response for ' + path); return r.json();
}
async function command(action, args) {
  const requestId = randomUUID();
  await api(admin, '/samba/commands', 'POST', { requestId, action, args }, 201);
  for (let i = 0; i < 100; i++) {
    const operation = await api(admin, '/samba/operations/' + requestId);
    if (operation.state === 'succeeded') return;
    assert(['pending', 'queued', 'running'].includes(operation.state), 'QA management operation failed');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('QA management operation timed out');
}
const fileURL = path => origin + '/api/files/content?' + new URLSearchParams({ share: f.share, path });
const normalize = rows => rows.map(({revision,...row}) => ({ ...row, ...(row.members ? { members: [...row.members].sort() } : {}) })).sort((a, b) => (a.id || a.name).localeCompare(b.id || b.name));
(async () => {
  assert(f.ad_name.startsWith('qa_') && f.share.startsWith('qa_'));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: new URL(origin).hostname + ',localhost,127.0.0.1' } } : {}) });
  admin = await browser.newContext({ ignoreHTTPSErrors: true }); employee = await browser.newContext({ ignoreHTTPSErrors: true });
  await api(admin, '/auth/sign-in/email', 'POST', { email: 'admin@assay.test', password: adminPassword });
  original = await api(admin, '/samba/snapshot'); assert.equal(original.domain.toLowerCase(), 'dc=assay,dc=test');
  const share = original.shares.find(s => s.name === f.share); assert(share?.active);
  const groupIds = share.groups.map(name => original.groups.find(g => g.name === name)?.id);
  assert(groupIds.every(Boolean));
  shareArgs = { name: share.name, comment: share.comment, groups: groupIds, read_only: share.read_only };
  const acl = await api(admin, '/samba/acl?' + new URLSearchParams({ share: f.share, path: '' }));
  pass('Management snapshot and Windows ACL remain accessible through the unified process');
  restoreShare = true;
  await command('share.save', { ...shareArgs, comment: 'QA unified in-process configuration reload' });
  assert.equal((await api(admin, '/samba/snapshot')).shares.find(s => s.name === f.share).comment, 'QA unified in-process configuration reload');
  await command('share.save', shareArgs); restoreShare = false;
  assert.deepEqual(normalize((await api(admin, '/samba/snapshot')).shares), normalize(original.shares));
  pass('In-process local configuration writes and smbd reload work without a helper; original configuration is restored');
  const login = await api(employee, '/auth/sign-in/directory', 'POST', { username: f.ad_name, password: f.ad_password }); assert(login.filesConnected);
  await command('directory.create', { share: f.share, path: folder }); folderCreated = true;
  const directories = await api(admin, '/samba/directories?' + new URLSearchParams({ share: f.share, path: '' })); assert(directories.directories.includes(folder));
  const list = await api(employee, '/files/list?' + new URLSearchParams({ share: f.share, path: '' })); assert(list.entries.some(e => e.name === folder));
  pass('Administrative directory creation is immediately visible through the employee own SMB connection');
  // Larger than the management JSON limit: the nested file router must keep streaming enabled.
  const bytes = randomBytes(128 * 1024);
  const upload = await employee.request.put(fileURL(file), { headers: { Origin: origin, 'Content-Type': 'application/octet-stream' }, data: bytes });
  assert.equal(upload.status(), 200); fileCreated = true;
  const download = await employee.request.get(fileURL(file)); assert.equal(download.status(), 200); assert.deepEqual(await download.body(), bytes);
  pass('A 128 KiB employee upload/download streams exact bytes without inheriting the management body limit');
  const status = await api(employee, '/files/status');
  const denied = original.shares.find(s => s.active && !status.shares.includes(s.name)); assert(denied);
  await api(employee, '/files/list?' + new URLSearchParams({ share: denied.name, path: '' }), 'GET', undefined, 403);
  pass('A process with local management permissions still denies employee SMB access to an unauthorized share');
  await api(employee, '/files/commands', 'POST', { action: 'delete', share: f.share, path: file }, 201); fileCreated = false;
  await command('directory.delete', { share: f.share, path: folder }); folderCreated = false;
  const current = await api(admin, '/samba/snapshot');
  assert.deepEqual(normalize(current.users), normalize(original.users)); assert.deepEqual(normalize(current.groups), normalize(original.groups)); assert.deepEqual(normalize(current.shares), normalize(original.shares));
  assert.equal((await api(admin, '/samba/acl?' + new URLSearchParams({ share: f.share, path: '' }))).revision, acl.revision);
  pass('QA files are removed; existing AD accounts, group membership, shares and root ACL stay unchanged');
  fs.writeFileSync(dir + '/unified-agent-result.json', JSON.stringify({ passed: results.length, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
})().catch(error => {
  let message = error.message; for (const secret of [adminPassword, f.ad_password, f.assay_password]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}).finally(async () => {
  try {
    if (fileCreated) await api(employee, '/files/commands', 'POST', { action: 'delete', share: f.share, path: file }, 201);
    if (folderCreated) await command('directory.delete', { share: f.share, path: folder });
    if (restoreShare) await command('share.save', shareArgs);
    for (const c of [employee, admin]) if (c) await api(c, '/auth/sign-out', 'POST', {});
  } catch { console.error('QA cleanup failed'); process.exitCode = 1; }
  await browser?.close();
});
