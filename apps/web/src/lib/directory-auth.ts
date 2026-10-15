import { apiOrigin } from './api';
import { SecurityRequestError } from './security-step-up';
export interface DirectoryProvider { enabled: boolean; name: string | null }
export class DirectorySignInError extends SecurityRequestError {
  constructor(status: number, readonly code?: 'DIRECTORY_LINK_REQUIRED') { super(status); }
}
export async function directoryProvider(): Promise<DirectoryProvider> {
  const res = await fetch(`${apiOrigin}/api/auth/directory/provider`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new SecurityRequestError(res.status);
  return res.json();
}
export async function directorySignIn(username: string, password: string, rememberMe: boolean, code?: string): Promise<{ twoFactorRequired?: boolean; destination?: string; filesConnected?: boolean }> {
  const res = await fetch(`${apiOrigin}/api/auth/sign-in/directory`, { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, rememberMe, ...(code ? { code } : {}) }) });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new DirectorySignInError(res.status, res.status === 403 && body?.code === 'DIRECTORY_LINK_REQUIRED' ? body.code : undefined);
  }
  return res.json();
}
