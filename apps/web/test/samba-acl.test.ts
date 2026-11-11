import { expect, test } from 'bun:test';
import { aclPermissionLabel, aclPermissionOptions } from '../src/features/samba/acl-permissions';

test('no-delete is offered at share roots and never confused with modify or full control', () => {
  expect(aclPermissionOptions(true, '').some(p => p.value === 'write_no_delete')).toBe(true);
  expect(aclPermissionOptions(true, 'subdir').some(p => p.value === 'write_no_delete')).toBe(false);
  expect(aclPermissionOptions(false, '').some(p => p.value === 'full')).toBe(false);
  expect(aclPermissionLabel(0x1201bf)).toBe('读写（禁止删除）');
  expect(aclPermissionLabel(0x1301bf)).toBe('修改');
  expect(aclPermissionLabel(0x1f01ff)).toBe('完全控制');
});
