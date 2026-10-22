import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { getConfig } from '../config';
import { requireAuthSecret } from './auth-secret';

// Server-only request context; never added to /me or returned to the browser.
export const webSessionScopes = new WeakMap<Request, { fingerprint: string; expiresAt: number }>();
export function webSessionFingerprint(token: string) {
  // 与 better-auth 共用同一把已校验的密钥（见 auth-secret.ts）
  return createHmac('sha256', requireAuthSecret()).update('employee-files\0').update(token).digest('hex');
}

type FileSessionRenewal = (scope: { fingerprint: string; expiresAt: number; userId: string }) => Promise<void>;
let renewFiles: FileSessionRenewal | undefined;
export function registerFileSessionRenewal(renewal?: FileSessionRenewal) { renewFiles = renewal; }
export function renewExistingFileSession(session: { token: string; userId?: string; expiresAt?: Date | string }, ttl: number) {
  const config = getConfig();
  if (!renewFiles || !config.samba.enabled || !config.files.enabled || !config.auth.secret || !session.userId || !session.expiresAt) return;
  const expiresAt = Math.min(new Date(session.expiresAt).getTime(), Date.now() + ttl * 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  // Optional file transport must not delay business login/requests. No callback
  // can create a connection: it only maintains a capability already held by it.
  void renewFiles({ fingerprint: webSessionFingerprint(session.token), userId: session.userId, expiresAt }).catch(() => {});
}
