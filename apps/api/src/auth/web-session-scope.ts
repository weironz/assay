import { createHmac } from 'node:crypto';
import type { Request } from 'express';

// Server-only request context; never added to /me or returned to the browser.
export const webSessionScopes = new WeakMap<Request, { fingerprint: string; expiresAt: number }>();
export function webSessionFingerprint(token: string) {
  if (!process.env.AUTH_SECRET) throw new Error('Session scope secret unavailable');
  return createHmac('sha256', process.env.AUTH_SECRET).update('employee-files\0').update(token).digest('hex');
}
