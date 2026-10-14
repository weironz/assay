import { afterEach, expect, test } from 'bun:test';
import { beginOidc, oidcProvider } from '../src/lib/oidc';
import { SecurityRequestError } from '../src/lib/security-step-up';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('enterprise sign-in uses a cookie-aware backend request and sends no tokens or arbitrary return paths', async () => {
  let request: { url: string; options?: RequestInit } | undefined;
  globalThis.fetch = (async (url, options) => {
    request = { url: String(url), options };
    return Response.json({ url: 'https://sso.example.test/authorize?state=opaque' });
  }) as typeof fetch;
  expect(await beginOidc('https://assay.example.test')).toBe('https://sso.example.test/authorize?state=opaque');
  expect(request!.url).toEndWith('/api/auth/sign-in/oidc');
  expect(request!.options!.credentials).toBe('include');
  expect(JSON.parse(request!.options!.body as string)).toEqual({ callbackURL: 'https://assay.example.test/dashboard' });
  expect(new Headers(request!.options!.headers).has('authorization')).toBe(false);
});
test('linking consumes a supplied step-up ticket only on the link request', async () => {
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_url, options) => { requests.push(options!); return Response.json({ url: 'https://sso.example.test/auth' }); }) as typeof fetch;
  await beginOidc('https://assay.example.test', 'single-use-ticket');
  await beginOidc('https://assay.example.test');
  expect(new Headers(requests[0].headers).get('x-step-up-token')).toBe('single-use-ticket');
  expect(JSON.parse(requests[0].body as string).callbackURL).toBe('https://assay.example.test/settings');
  expect(new Headers(requests[1].headers).has('x-step-up-token')).toBe(false);
});
test('disabled providers can be discovered without exposing credentials', async () => {
  globalThis.fetch = (async () => Response.json({ enabled: false, name: null })) as typeof fetch;
  expect(await oidcProvider()).toEqual({ enabled: false, name: null });
});
test('SSO errors keep only the HTTP status and reject unsafe authorization navigation', async () => {
  globalThis.fetch = (async () => Response.json({ message: 'provider secret' }, { status: 503 })) as typeof fetch;
  await expect(beginOidc('https://assay.example.test')).rejects.toBeInstanceOf(SecurityRequestError);
  for (const url of ['javascript:alert(1)', 'https://secret@sso.example.test']) {
    globalThis.fetch = (async () => Response.json({ url })) as typeof fetch;
    await expect(beginOidc('https://assay.example.test')).rejects.toBeInstanceOf(SecurityRequestError);
  }
});
