import { afterEach, expect, test } from 'bun:test';
import { api } from '../src/lib/api.ts';
import {
  SecurityRequestError,
  enrollmentRequired,
  guardedApi,
  issueStepUp,
  securityErrorKey,
  securityStatus,
  stepUpHeaders,
} from '../src/lib/security-step-up.ts';

const originalFetch = globalThis.fetch;
const originalAdapter = api.defaults.adapter;

afterEach(() => {
  globalThis.fetch = originalFetch;
  api.defaults.adapter = originalAdapter;
});

test('GET security status uses the cookie-aware API and returns the contract fields', async () => {
  const status = {
    privilegedMfaMode: 'enforce', privileged: true, enrolled: false,
    enrollmentRequired: true, stepUpTtlSeconds: 300,
    purposes: ['roles', 'api-tokens', 'two-factor', 'account'],
  };
  let request;
  api.defaults.adapter = async (config) => {
    request = config;
    return { data: status, status: 200, statusText: 'OK', headers: {}, config };
  };

  expect(await securityStatus()).toEqual(status);
  expect(request.url).toBe('/me/security');
  expect(request.withCredentials).toBe(true);
});

for (const purpose of ['roles', 'api-tokens', 'two-factor', 'account']) {
  test(`step-up sends purpose ${purpose}, password and optional TOTP with cookies`, async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return Response.json({ stepUpToken: 'issued-once', expiresInSeconds: 300 });
    };

    expect(await issueStepUp(purpose, 'current-password', '123456')).toBe('issued-once');
    expect(requests).toHaveLength(1);
    const { url, options } = requests[0];
    expect(new URL(url, 'http://localhost').pathname).toBe('/api/me/security/step-up');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(options.headers).has('x-step-up-token')).toBe(false);
    expect(JSON.parse(options.body)).toEqual({ purpose, password: 'current-password', code: '123456' });
  });
}

test('step-up omits code when not enrolled and rejects a missing token', async () => {
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ expiresInSeconds: 300 });
  };
  await expect(issueStepUp('roles', 'password')).rejects.toBeInstanceOf(SecurityRequestError);
  expect(body).toEqual({ purpose: 'roles', password: 'password' });
});

test('challenge failure exposes only the HTTP status, never the backend message', async () => {
  globalThis.fetch = async () => Response.json({ message: 'raw backend secret' }, { status: 401 });
  let failure;
  try { await issueStepUp('roles', 'wrong'); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SecurityRequestError);
  expect(failure.status).toBe(401);
  expect(failure.message).toBe('Security request failed');
  expect(securityErrorKey(failure)).toBe('stepUp.invalidCredentials');
  expect(JSON.stringify(failure)).not.toContain('raw backend secret');
});

test('guarded JSON mutation sends one header on one request and returns response data', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ id: 'new-user' }, { status: 201 });
  };
  expect(await guardedApi('POST', '/users', 'one-shot', { name: 'Alice' })).toEqual({ id: 'new-user' });
  expect(requests).toHaveLength(1);
  const { url, options } = requests[0];
  expect(new URL(url, 'http://localhost').pathname).toBe('/api/users');
  expect(options.credentials).toBe('include');
  expect(options.method).toBe('POST');
  expect(new Headers(options.headers).get('x-step-up-token')).toBe('one-shot');
  expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
  expect(JSON.parse(options.body)).toEqual({ name: 'Alice' });
});

test('guarded no-body mutation does not reuse a prior token or add a JSON body', async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return new Response(null, { status: 204 });
  };
  expect(await guardedApi('DELETE', '/users/1', 'first')).toBeUndefined();
  expect(await guardedApi('DELETE', '/users/2', 'second')).toBeUndefined();
  expect(requests).toHaveLength(2);
  expect(new Headers(requests[0].headers).get('x-step-up-token')).toBe('first');
  expect(new Headers(requests[1].headers).get('x-step-up-token')).toBe('second');
  for (const request of requests) {
    expect(request.body).toBeUndefined();
    expect(new Headers(request.headers).has('Content-Type')).toBe(false);
  }
  expect(stepUpHeaders('third')).toEqual({ 'x-step-up-token': 'third' });
});

test('guarded mutation failure keeps only status, without response body or request config', async () => {
  globalThis.fetch = async () => Response.json({ message: 'private backend detail' }, { status: 403 });
  let failure;
  try { await guardedApi('PATCH', '/users/1', 'sensitive-token', { roleNames: ['admin'] }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SecurityRequestError);
  expect(failure.status).toBe(403);
  expect(securityErrorKey(failure)).toBe('stepUp.forbidden');
  expect(JSON.stringify(failure)).not.toContain('sensitive-token');
  expect(JSON.stringify(failure)).not.toContain('private backend detail');
  expect(failure.config).toBeUndefined();
});

test('status errors map to localizable keys with a safe fallback', () => {
  const cases = [
    [400, 'stepUp.invalidRequest'], [422, 'stepUp.invalidRequest'],
    [401, 'stepUp.invalidCredentials'], [403, 'stepUp.forbidden'],
    [409, 'stepUp.conflict'], [429, 'stepUp.rateLimited'],
    [500, 'stepUp.actionFailed'],
  ];
  for (const [status, key] of cases) expect(securityErrorKey(new SecurityRequestError(status))).toBe(key);
  expect(securityErrorKey(new Error('raw backend message'))).toBe('stepUp.actionFailed');
  expect(securityErrorKey(new SecurityRequestError(), 'twoFactor.failed')).toBe('twoFactor.failed');
});

test('enrollmentRequired obeys explicit status and derives enforce-only fallback', () => {
  const base = { privilegedMfaMode: 'enforce', privileged: true, enrolled: false, stepUpTtlSeconds: 300 };
  expect(enrollmentRequired({ ...base, enrollmentRequired: false })).toBe(false);
  expect(enrollmentRequired({ ...base, enrollmentRequired: true })).toBe(true);
  expect(enrollmentRequired(base)).toBe(true);
  expect(enrollmentRequired({ ...base, enrolled: true })).toBe(false);
  expect(enrollmentRequired({ ...base, privileged: false })).toBe(false);
  expect(enrollmentRequired({ ...base, privilegedMfaMode: 'optional' })).toBe(false);
});
