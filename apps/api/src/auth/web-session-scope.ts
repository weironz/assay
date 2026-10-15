import { createHmac } from 'node:crypto';
import type { Request } from 'express';

// Server-only request context; never added to /me or returned to the browser.
export const webSessionScopes = new WeakMap<Request, { fingerprint: string; expiresAt: number }>();
export function webSessionFingerprint(token: string) {
  if (!process.env.AUTH_SECRET) throw new Error('Session scope secret unavailable');
  return createHmac('sha256', process.env.AUTH_SECRET).update('employee-files\0').update(token).digest('hex');
}

type FileSessionRenewal = (scope: { fingerprint: string; expiresAt: number; userId: string }) => Promise<void>;
let renewFiles: FileSessionRenewal | undefined;
export function registerFileSessionRenewal(renewal?: FileSessionRenewal) { renewFiles = renewal; }
export function renewExistingFileSession(session: { token: string; userId?: string; expiresAt?: Date | string }, ttl: number) {
  if (!renewFiles || process.env.SAMBA_ENABLED !== 'true' || process.env.FILES_ENABLED !== 'true' || !process.env.AUTH_SECRET || !session.userId || !session.expiresAt) return;
  const expiresAt = Math.min(new Date(session.expiresAt).getTime(), Date.now() + ttl * 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  // Optional file transport must not delay business login/requests. No callback
  // can create a connection: it only maintains a capability already held by it.
  void renewFiles({ fingerprint: webSessionFingerprint(session.token), userId: session.userId, expiresAt }).catch(() => {});
}
