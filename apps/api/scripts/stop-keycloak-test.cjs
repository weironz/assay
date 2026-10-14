const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const directory = path.resolve(process.argv[2] || '.oidc-test');
const webConfig = `vite.keycloak-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}.config.ts`;
const exited = pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return ['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]);
  } catch { return true; }
};
(async () => {
for (const name of ['web', 'api']) {
  const file = path.join(directory, name + '.pid');
  if (!fs.existsSync(file)) continue;
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid saved test PID');
  let command, cwd;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0])) {
      fs.unlinkSync(file); continue;
    }
    command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch { continue; }
  const ours = name === 'api'
    ? cwd === path.join(directory, 'api') && command.includes('dist/main.js')
    : command.includes('vite') && command.includes(webConfig);
  if (!ours) throw new Error('Saved PID does not identify this test process; refusing to stop it');
  // The start script creates a separate process group for each service.
  process.kill(-pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && !exited(pid); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!exited(pid)) throw new Error('Test process has not exited yet; retain its PID and retry');
  fs.unlinkSync(file);
  console.log('Stopped isolated test process:', name);
}
})().catch(error => { console.error(error.message); process.exitCode = 1; });
