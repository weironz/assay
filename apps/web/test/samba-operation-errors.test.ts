import { expect, test, afterEach } from 'bun:test';
import { api } from '../src/lib/api';
import { OperationError } from '../src/lib/operation-error';
import { awaitOperation } from '../src/features/samba/operations';

const adapter = api.defaults.adapter;
afterEach(() => { api.defaults.adapter = adapter; });

test('a password policy failure remains an actionable operation error after polling', async () => {
  api.defaults.adapter = async config => ({ data: { id: 'op', state: 'failed', result: { error_code: 'AD_PASSWORD_COMPLEXITY', error: 'LDAP raw secret' } }, status: 200, statusText: 'OK', headers: {}, config });
  let failure: unknown;
  try { await awaitOperation({ id: 'op', state: 'queued' }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(OperationError);
  const error = failure as OperationError;
  expect(error.message).toContain('复杂度');
  expect(error.message).not.toContain('LDAP');
  expect(error.message).not.toContain('稍后重试');
});

test('permissions, connectivity, current-password and history errors are distinct', () => {
  expect(new OperationError('AD_PERMISSION_DENIED').message).toContain('权限不足');
  expect(new OperationError('AD_CONNECTION_FAILED').message).toContain('无法连接');
  expect(new OperationError('AD_CURRENT_PASSWORD_INVALID').message).toContain('当前 AD 密码不正确');
  expect(new OperationError('AD_PASSWORD_HISTORY').message).toContain('重复');
  expect(new OperationError('AD_PASSWORD_REJECTED').message).toContain('尚未确认');
});

test('unknown or legacy protocol failures cannot leak raw diagnostics into a dialog', async () => {
  for (const code of [undefined, 'PRIVATE_SECRET', '__proto__']) {
    let failure: unknown;
    try { await awaitOperation({ id: 'op', state: 'failed', result: { error_code: code, error: 'private LDAP data' } }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OperationError);
    expect((failure as Error).message).toBe('操作未完成，请核对操作记录与资源状态。');
  }
  expect(await awaitOperation({ id: 'done', state: 'succeeded' })).toEqual({ id: 'done', state: 'succeeded' });
});
