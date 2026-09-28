import { createClient } from 'redis';

// Shared by Better Auth and step-up tickets; Redis failure must fail closed.
export const authRedis = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379',
});
authRedis.on('error', (e) => console.error('[better-auth redis]', e.message));
authRedis.connect().catch((e) => console.error('[better-auth redis connect]', e));
