const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
const { authRedis } = require('../dist/auth/auth-redis');
const { checkStepUpRate } = require('../dist/auth/step-up-store');

test.after(async () => { if (authRedis.isOpen) await authRedis.quit(); });

test('real Redis rate counter is bounded and repairs a legacy key without TTL', async () => {
  assert.equal(await authRedis.ping(), 'PONG');
  const userId = `assay-security-${randomUUID()}`;
  const key = `assay:step-up:attempts:${createHash('sha256').update(userId).digest('hex')}`;
  try {
    await authRedis.set(key, '1'); // old INCR may have left this key without expiry
    assert.equal(await authRedis.ttl(key), -1);
    await checkStepUpRate(userId);
    const ttl = await authRedis.ttl(key);
    assert.ok(ttl > 0 && ttl <= 900, `counter TTL: ${ttl}`);
    for (let n = 0; n < 3; n++) await checkStepUpRate(userId);
    await assert.rejects(checkStepUpRate(userId), { status: 429 });
    assert.ok((await authRedis.ttl(key)) > 0);
  } finally {
    await authRedis.del(key);
  }
});
