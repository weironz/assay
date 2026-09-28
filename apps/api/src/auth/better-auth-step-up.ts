import { APIError } from 'better-auth';
import { consumeStepUp, privilegedMfaMode } from './step-up-store';

type Session = { user: { id: string }; session: { token: string } };
type UserState = {
  status: string;
  twoFactorEnabled: boolean;
  twoFactor?: { verified: boolean } | null;
  roles: { role: { name: string } }[];
};

export async function enforceBetterAuthSensitiveStepUp(
  path: string,
  headers: Headers | undefined,
  lookup: {
    session: () => Promise<Session | null>;
    user: (id: string) => Promise<UserState | null>;
    consume?: typeof consumeStepUp;
  },
): Promise<void> {
  if (![
    '/two-factor/disable', '/two-factor/enable',
    '/two-factor/generate-backup-codes', '/two-factor/get-totp-uri',
    '/delete-user', '/delete-user/callback',
  ].includes(path)) return;
  // No deletion email callback is configured; do not leave a future alternate
  // route that can complete deletion without a fresh account step-up.
  if (path === '/delete-user/callback') {
    throw new APIError('FORBIDDEN', { message: '账号删除回调未启用' });
  }
  if (!headers || headers.has('authorization')) {
    throw new APIError('UNAUTHORIZED', { message: '仅支持网页登录会话' });
  }
  const current = await lookup.session();
  if (!current?.session) throw new APIError('UNAUTHORIZED', { message: '会话无效' });
  const user = await lookup.user(current.user.id);
  if (!user || user.status !== 'ACTIVE') throw new APIError('UNAUTHORIZED', { message: '账号无效' });

  // Better Auth requires the password for initial enrollment. Its enable
  // endpoint replaces an enrolled secret, so only that branch is exempt.
  if ((path === '/two-factor/enable' || path === '/two-factor/get-totp-uri') &&
      !user.twoFactorEnabled && !user.twoFactor?.verified) return;
  if (path === '/two-factor/disable' && privilegedMfaMode() === 'enforce' &&
      user.roles.some((r) => r.role.name === 'admin' || r.role.name === 'supervisor')) {
    throw new APIError('FORBIDDEN', { message: '强制 MFA 模式下需先移除特权角色才能停用 TOTP' });
  }
  try {
    await (lookup.consume ?? consumeStepUp)(
      headers.get('x-step-up-token'), current.user.id, current.session.token,
      path === '/delete-user' ? 'account' : 'two-factor',
    );
  } catch {
    throw new APIError('FORBIDDEN', { message: '需要有效且未使用的安全验证' });
  }
}
