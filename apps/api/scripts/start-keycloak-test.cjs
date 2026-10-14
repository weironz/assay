const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const directory = path.resolve(process.argv[2] || '.oidc-test');
if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_oidc_test')) {
  throw new Error('Load the generated assay.env for an isolated OIDC test database');
}
for (const name of ['api', 'web']) {
  const pidFile = path.join(directory, name + '.pid');
  if (!fs.existsSync(pidFile)) continue;
  let running = false;
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    process.kill(pid, 0);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    running = !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]);
  } catch {}
  if (running) throw new Error(`The test ${name} is already running; stop it before rebuilding`);
}
const api = path.join(directory, 'api');
fs.mkdirSync(api, { recursive: true, mode: 0o700 });
for (const name of ['src', 'prisma']) fs.cpSync(path.join(root, 'apps/api', name), path.join(api, name), { recursive: true });
for (const name of ['package.json', 'tsconfig.json', 'nest-cli.json']) fs.copyFileSync(path.join(root, 'apps/api', name), path.join(api, name));
if (!fs.existsSync(path.join(api, 'node_modules'))) fs.symlinkSync(path.join(root, 'apps/api/node_modules'), path.join(api, 'node_modules'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: api, env: process.env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Test startup check failed: ' + command);
}
run('pnpm', ['--ignore-workspace', 'prisma', 'generate']);
run('pnpm', ['--ignore-workspace', 'prisma', 'migrate', 'deploy']);
run('pnpm', ['--ignore-workspace', 'exec', 'tsc']);
run(process.execPath, ['dist/seed.js']);
function launch(name, command, args, cwd, env = process.env) {
  const log = fs.openSync(path.join(directory, name + '.log'), 'a', 0o600);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', log, log], detached: true });
  child.unref(); fs.writeFileSync(path.join(directory, name + '.pid'), String(child.pid), { mode: 0o600 });
}
launch('api', process.execPath, [path.join(api, 'dist/main.js')], api);
const config = path.join(root, 'apps/web/node_modules/.cache', `vite.keycloak-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}.config.ts`);
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.writeFileSync(config, `import { mergeConfig } from 'vite';\nimport original from ${JSON.stringify(path.join(root, 'apps/web/vite.config'))};\nexport default mergeConfig(original,{server:{host:'127.0.0.1',port:5190,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:3190',changeOrigin:false}}}});\n`);
launch('web', 'pnpm', ['--ignore-workspace', 'exec', 'vite', '--config', config], path.join(root, 'apps/web'), { ...process.env, VITE_API_BASE_URL: '' });
console.log('Started isolated test API (3190) and Web (5190); logs and process IDs:', directory);
