import { expect, test } from 'bun:test';
import { PLATFORM_MODULE, activeMenuItem, allowedItems, moduleForPath } from '../src/lib/business-navigation';

test('platform navigation respects each permission and does not expose a landing page to ordinary requesters', () => {
  expect(allowedItems(PLATFORM_MODULE.items, () => false)).toHaveLength(0);
  const directory = allowedItems(PLATFORM_MODULE.items, p => p === 'samba:read').map(i => i.to);
  expect(directory).toContain('/platform');
  expect(directory).toContain('/samba/users');
  expect(directory).not.toContain('/users');
  expect(directory).not.toContain('/organization');
  expect(allowedItems(PLATFORM_MODULE.items, p => p === 'user:manage').map(i => i.to)).toEqual(['/platform', '/users']);
});
test('entity deep links retain the correct platform sidebar section', () => {
  for (const path of ['/samba/users/abc', '/samba/groups/def', '/samba/shares/finance']) {
    expect(moduleForPath(path)?.id).toBe('platform');
    expect(activeMenuItem(PLATFORM_MODULE.items, path, new URLSearchParams())).toBe(path.split('/').slice(0, 3).join('/'));
  }
});
