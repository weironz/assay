const { spawnSync } = require('node:child_process');
const path = require('node:path');
if (!process.env.COP_TEST_DATABASE_URL && !process.env.DATABASE_URL)
  throw Error('COP_TEST_DATABASE_URL or DATABASE_URL required');
const url = new URL(
  process.env.COP_TEST_DATABASE_URL || process.env.DATABASE_URL,
);
if (!process.env.COP_TEST_DATABASE_URL) url.pathname = '/assay_cop_test';
if (!url.pathname.endsWith('_cop_test'))
  throw Error(
    'Refuse to test against a live database: isolated name must end with _cop_test',
  );
const env = {
  ...process.env,
  DATABASE_URL: url.href,
  COP_TEST_DATABASE_URL: url.href,
};
for (const [cmd, args] of [
  ['pnpm', ['prisma', 'migrate', 'deploy']],
  [
    process.execPath,
    [
      '--require',
      'ts-node/register/transpile-only',
      '--test',
      '--test-reporter=tap',
      'test/cop.integration.test.cjs',
    ],
  ],
]) {
  const result = spawnSync(cmd, args, {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
