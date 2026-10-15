const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const script = `process.stdout.write(require(${JSON.stringify(path.join(__dirname, 'test-origin.cjs'))}))`;
function resolve(origin) {
  const env = { ...process.env };
  if (origin === undefined) delete env.SAMBA_E2E_ORIGIN;
  else env.SAMBA_E2E_ORIGIN = origin;
  return spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
}
test('remote test target must be explicitly configured and cannot contain credentials or paths', () => {
  assert.notEqual(resolve().status, 0);
  for (const value of ['https://example.test/api', 'https://user:secret@example.test', 'https://example.test/?x=1', 'https://example.test/#fragment', 'http://example.test', 'invalid']) {
    assert.notEqual(resolve(value).status, 0);
  }
  for (const value of ['https://example.test:8446', 'http://127.0.0.1:8446']) {
    const result = resolve(value);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, value);
  }
});
