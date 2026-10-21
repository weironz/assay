import { expect, test } from 'bun:test';
import { filterUsers, invalidUserField, newUserPayload } from '../src/features/access/user-directory';

test('new user payload trims identity fields, deduplicates roles and preserves password whitespace', () => {
  const form = { name: '  Alice  ', email: ' alice@example.test ', password: '  secret password  ', roleNames: ['requester', 'requester', 'handler'] };
  expect(newUserPayload(form)).toEqual({ name: 'Alice', email: 'alice@example.test', password: '  secret password  ', roleNames: ['requester', 'handler'] });
  expect(form.roleNames).toEqual(['requester', 'requester', 'handler']);
  expect(form.name).toBe('  Alice  ');
});
test('basic validation rejects blank or short names and passwords before advancing', () => {
  const form = { name: 'Alice', email: 'alice@example.test', password: 'secret', roleNames: [] };
  expect(invalidUserField(form)).toBeNull();
  expect(invalidUserField({ ...form, name: '   ' })).toBe('name');
  expect(invalidUserField({ ...form, name: ' A ' })).toBe('name');
  expect(invalidUserField({ ...form, email: ' ' })).toBe('email');
  expect(invalidUserField({ ...form, password: '12345' })).toBe('password');
});

const users = [
  { name: 'Alice', email: 'alice@example.test', roles: ['requester'], directoryRoles: ['cop_viewer'], directoryAccount: 'alice.ad' },
  { name: '测试用户', email: 'test@example.test', roles: ['handler'], directoryRoles: [] },
];
const label = (role: string) => ({ requester: '提单人', cop_viewer: '运营平台观察员', handler: '处理人' })[role] ?? role;
test('user search matches names, email, local roles and inherited roles without case sensitivity', () => {
  for (const query of [' ALICE ', 'example.test requester', 'alice.ad', '运营平台观察员', 'cop_viewer']) {
    expect(filterUsers(users, query, label)).toEqual([users[0]]);
  }
  expect(filterUsers(users, '处理人', label)).toEqual([users[1]]);
  expect(filterUsers(users, '测试', label)).toEqual([users[1]]);
  expect(filterUsers(users, '', label)).toEqual(users);
  expect(filterUsers(users, 'does-not-exist', label)).toEqual([]);
  expect(users[0].roles).toEqual(['requester']);
});
