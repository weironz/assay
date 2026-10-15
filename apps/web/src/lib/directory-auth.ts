import { apiOrigin } from './api';
import { SecurityRequestError } from './security-step-up';
export interface DirectoryProvider { enabled: boolean; name: string | null }
export async function directoryProvider(): Promise<DirectoryProvider> {
  const res = await fetch(`${apiOrigin}/api/auth/directory/provider`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new SecurityRequestError(res.status);
  return res.json();
}
export async function directorySignIn(username: string, password: string, rememberMe: boolean, code?: string): Promise<{ twoFactorRequired?: boolean; destination?: string; filesConnected?: boolean }> {
  const res = await fetch(`${apiOrigin}/api/auth/sign-in/directory`, { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, rememberMe, ...(code ? { code } : {}) }) });
  if (!res.ok) throw new SecurityRequestError(res.status);
  return res.json();
}
