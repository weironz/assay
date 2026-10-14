import { apiOrigin } from './api';
import { SecurityRequestError, stepUpHeaders } from './security-step-up';

export type OidcProvider = { enabled: boolean; name: string | null };
export type OidcAccount = { linked: boolean; canLink: boolean };

async function oidcRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiOrigin}/api/auth${path}`, { ...init, credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new SecurityRequestError(response.status);
  return response.json() as Promise<T>;
}
export const oidcProvider = () => oidcRequest<OidcProvider>('/oidc/provider');
export const oidcAccount = () => oidcRequest<OidcAccount>('/oidc/account');

export async function beginOidc(origin: string, stepUpToken?: string): Promise<string> {
  const linking = Boolean(stepUpToken);
  const result = await oidcRequest<{ url: string }>(linking ? '/oidc/link' : '/sign-in/oidc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(stepUpToken ? stepUpHeaders(stepUpToken) : {}) },
    body: JSON.stringify({ callbackURL: `${origin}${linking ? '/settings' : '/dashboard'}` }),
  });
  const url = new URL(result.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SecurityRequestError();
  return url.href;
}
