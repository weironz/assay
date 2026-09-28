const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
const { authRedis } = require('../dist/auth/auth-redis');
const { auth } = require('../dist/auth/auth');

test.after(async () => { if (authRedis.isOpen) await authRedis.quit(); });

test('Better Auth deleteUserSessions removes Redis-backed session tokens and index', async () => {
  assert.equal(await authRedis.ping(), 'PONG');
  const userId = `assay-security-${randomUUID()}`;
  const token = `assay-security-session-${randomUUID()}`;
  const listKey = `active-sessions-${userId}`;
  try {
    await authRedis.set(token, JSON.stringify({ session: { token, userId } }), { EX: 60 });
    await authRedis.set(listKey, JSON.stringify([{ token, expiresAt: Date.now() + 60_000 }]), { EX: 60 });
    const context = await auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
    assert.equal(await authRedis.get(token), null);
    assert.equal(await authRedis.get(listKey), null);
  } finally {
    await authRedis.del([token, listKey]);
  }
});
