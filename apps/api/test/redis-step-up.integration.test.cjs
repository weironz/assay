const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
const { authRedis } = require('../dist/auth/auth-redis');
const { issueStepUp, consumeStepUp, reserveTotpCode, STEP_UP_TTL_SECONDS } = require('../dist/auth/step-up-store');

const digest = (value) => createHash('sha256').update(value).digest('hex');

test.after(async () => {
  if (authRedis.isOpen) await authRedis.quit();
});

test('real Redis enforces one-use step-up tickets and TOTP reservation', async () => {
  assert.equal(await authRedis.ping(), 'PONG');
  const userId = `assay-ci-${randomUUID()}`;
  const session = randomUUID();
  const code = '123456';
  const keys = [];
  try {
    const ticket = await issueStepUp(userId, session, 'roles');
    const ticketKey = `assay:step-up:ticket:${digest(ticket)}`;
    keys.push(ticketKey);
    const ttl = await authRedis.ttl(ticketKey);
    assert.ok(ttl > 0 && ttl <= STEP_UP_TTL_SECONDS, `ticket TTL: ${ttl}`);

    const attempts = await Promise.allSettled([
      consumeStepUp(ticket, userId, session, 'roles'),
      consumeStepUp(ticket, userId, session, 'roles'),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(await authRedis.exists(ticketKey), 0);

    const totpKey = `assay:step-up:totp:${digest(`${userId}:${code}`)}`;
    keys.push(totpKey);
    await reserveTotpCode(userId, code);
    await assert.rejects(reserveTotpCode(userId, code));
    assert.ok((await authRedis.ttl(totpKey)) > 0);
  } finally {
    await authRedis.del(keys);
  }
});
