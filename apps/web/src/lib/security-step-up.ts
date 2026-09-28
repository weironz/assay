import { api, apiOrigin } from './api';

export type StepUpPurpose = 'roles' | 'api-tokens' | 'two-factor' | 'account';
export type SecurityStatus = {
  privilegedMfaMode: 'optional' | 'enforce';
  privileged: boolean;
  enrolled: boolean;
  enrollmentRequired?: boolean;
  stepUpTtlSeconds: number;
};

export class SecurityRequestError extends Error {
  constructor(readonly status?: number) {
    super('Security request failed');
    this.name = 'SecurityRequestError';
  }
}

export function securityErrorKey(error: unknown, fallback = 'stepUp.actionFailed'): string {
  if (!(error instanceof SecurityRequestError)) return fallback;
  switch (error.status) {
    case 400: case 422: return 'stepUp.invalidRequest';
    case 401: return 'stepUp.invalidCredentials';
    case 403: return 'stepUp.forbidden';
    case 409: return 'stepUp.conflict';
    case 429: return 'stepUp.rateLimited';
    default: return fallback;
  }
}

export async function securityStatus(): Promise<SecurityStatus> {
  return (await api.get<SecurityStatus>('/me/security')).data;
}

export async function issueStepUp(purpose: StepUpPurpose, password: string, code?: string): Promise<string> {
  // A wrong password is a challenge failure (401), not a session logout.
  // The shared Axios interceptor treats every non-/me 401 as a logout.
  const response = await fetch(`${apiOrigin}/api/me/security/step-up`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose, password, ...(code ? { code } : {}) }),
  });
  if (!response.ok) throw new SecurityRequestError(response.status);
  const data = await response.json() as { stepUpToken?: string; expiresInSeconds?: number };
  if (!data.stepUpToken) throw new SecurityRequestError();
  return data.stepUpToken;
}

export async function guardedApi<T = void>(method: 'POST' | 'PATCH' | 'DELETE', path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    method,
    credentials: 'include',
    headers: { ...stepUpHeaders(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new SecurityRequestError(response.status);
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export function enrollmentRequired(status: SecurityStatus) {
  return status.enrollmentRequired ?? (status.privilegedMfaMode === 'enforce' && status.privileged && !status.enrolled);
}

// Use only on the immediately following mutation. Never store this token in app state or storage.
export function stepUpHeaders(token: string) {
  return { 'x-step-up-token': token };
}
