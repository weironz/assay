import { createHash, randomBytes } from 'crypto';
import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { authRedis } from './auth-redis';

export type StepUpPurpose = 'roles' | 'api-tokens' | 'two-factor' | 'account';
export const STEP_UP_TTL_SECONDS = 300;
const STEP_UP_ATTEMPT_WINDOW_SECONDS = 900;
// A single Redis command prevents INCR succeeding without an expiry when a
// process crashes, and repairs counters left without TTL by older releases.
const INCREMENT_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function privilegedMfaMode(): 'optional' | 'enforce' {
  return process.env.PRIVILEGED_MFA_MODE === 'enforce' ? 'enforce' : 'optional';
}

export async function checkStepUpRate(userId: string): Promise<void> {
  const key = `assay:step-up:attempts:${digest(userId)}`;
  const attempts = Number(await authRedis.eval(INCREMENT_WITH_TTL, {
    keys: [key], arguments: [String(STEP_UP_ATTEMPT_WINDOW_SECONDS)],
  }));
  if (attempts > 5) throw new HttpException('安全验证尝试过多，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
}

export async function issueStepUp(userId: string, sessionToken: string, purpose: StepUpPurpose): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await authRedis.set(`assay:step-up:ticket:${digest(ticket)}`, JSON.stringify({
    userId, sessionHash: digest(sessionToken), purpose,
  }), { EX: STEP_UP_TTL_SECONDS, NX: true });
  return ticket;
}

export async function consumeStepUp(
  ticket: unknown, userId: string, sessionToken: string, purpose: StepUpPurpose,
): Promise<void> {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new ForbiddenException('需要安全验证');
  }
  // GETDEL is atomic across API instances: a ticket can authorize one request only.
  const value = await authRedis.getDel(`assay:step-up:ticket:${digest(ticket)}`);
  if (!value) throw new ForbiddenException('安全验证已过期或已使用');
  let stored: { userId: string; sessionHash: string; purpose: string };
  try { stored = JSON.parse(value); } catch { throw new ForbiddenException('安全验证无效'); }
  if (stored.userId !== userId || stored.sessionHash !== digest(sessionToken) || stored.purpose !== purpose) {
    throw new ForbiddenException('安全验证与当前会话或操作不匹配');
  }
}

export async function reserveTotpCode(userId: string, code: string): Promise<void> {
  const key = `assay:step-up:totp:${digest(`${userId}:${code}`)}`;
  const result = await authRedis.set(key, '1', { EX: 90, NX: true });
  if (result !== 'OK') throw new ForbiddenException('验证码已用于安全验证，请等待下一组验证码');
}
