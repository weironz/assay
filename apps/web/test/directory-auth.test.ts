import { afterEach, expect, test } from 'bun:test';
import { directorySignIn, DirectorySignInError } from '../src/lib/directory-auth';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test('authenticated company users get an explicit association error without raw server messages', async () => {
  globalThis.fetch = async () => Response.json({ code: 'DIRECTORY_LINK_REQUIRED', message: 'private directory detail' }, { status: 403 });
  let error: DirectorySignInError | undefined;
  try { await directorySignIn('employee', 'not-a-real-password', true); } catch (e) { error = e as DirectorySignInError; }
  expect(error).toBeInstanceOf(DirectorySignInError);
  expect(error?.code).toBe('DIRECTORY_LINK_REQUIRED');
  expect(error?.message).not.toContain('private');
});
test('bad credentials and arbitrary server errors cannot become a link-required hint', async () => {
  for (const [status, code] of [[401, 'DIRECTORY_LINK_REQUIRED'], [403, 'RAW_PRIVATE_DETAIL']] as const) {
    globalThis.fetch = async () => Response.json({ code }, { status });
    try { await directorySignIn('employee', 'not-a-real-password', true); throw Error('Expected a rejection'); }
    catch (e) { expect(e).toBeInstanceOf(DirectorySignInError); expect((e as DirectorySignInError).code).toBeUndefined(); }
  }
});
