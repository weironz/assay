const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (!process.env.OIDC_TEST_DATABASE_URL) throw new Error('OIDC_TEST_DATABASE_URL is required');
const url = new URL(process.env.OIDC_TEST_DATABASE_URL);
if (!url.pathname.endsWith('_oidc_test')) throw new Error('Refuse to test against a live database: name must end with _oidc_test');
const env = { ...process.env, DATABASE_URL: url.href, OIDC_TEST_DATABASE_URL: url.href };
for (const [command, args] of [
  ['pnpm', ['prisma', 'generate']],
  ['pnpm', ['prisma', 'migrate', 'deploy']],
  [process.execPath, ['--require', 'ts-node/register/transpile-only', '--test', 'test/oidc-config.test.cjs', 'test/oidc.integration.test.cjs']],
]) {
  const result = spawnSync(command, args, { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
