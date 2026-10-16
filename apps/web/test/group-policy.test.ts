import { expect, test } from 'bun:test';
import { groupNameError } from '../src/features/samba/group-policy';

test('OU-scoped groups accept literal unprefixed names and existing department names', () => {
  for (const name of ['test', 'dept_test', 'qa_team', 'a'.repeat(48)]) expect(groupNameError(name, '', [])).toBe('');
});

test('group validation rejects unsupported names without trimming, renaming or truncating', () => {
  for (const name of ['', '部门', 'test team', ' test', 'test ', 'team/admin', 'a'.repeat(49)]) expect(groupNameError(name, '', [])).not.toBe('');
  expect(groupNameError('administrator', '', [])).toContain('保留名');
  expect(groupNameError('test', '', ['TEST'])).toContain('已存在');
  expect(groupNameError('test', 'custom_', [])).toContain('custom_');
  expect(groupNameError('custom_test', 'custom_', [])).toBe('');
});
