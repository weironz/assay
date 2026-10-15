import { expect, test } from 'bun:test';
import { BUSINESS_MODULES, PLATFORM_MODULE, activeMenuItem, allowedItems, moduleForPath } from '../src/lib/business-navigation';

test('platform navigation respects each permission and does not expose a landing page to ordinary requesters', () => {
  expect(allowedItems(PLATFORM_MODULE.items, () => false)).toHaveLength(0);
  const directory = allowedItems(PLATFORM_MODULE.items, p => p === 'samba:read').map(i => i.to);
  expect(directory).toEqual([]);
  expect(directory).not.toContain('/users');
  expect(directory).not.toContain('/organization');
  expect(allowedItems(PLATFORM_MODULE.items, p => p === 'user:manage').map(i => i.to)).toEqual(['/platform', '/users']);
});
test('directory deep links retain their independent module sidebar', () => {
  const directory = BUSINESS_MODULES.find(m => m.id === 'directory')!;
  for (const path of ['/samba/users/abc', '/samba/groups/def', '/samba/shares/finance']) {
    expect(moduleForPath(path)?.id).toBe('directory');
    expect(activeMenuItem(directory.items, path, new URLSearchParams())).toBe(path.split('/').slice(0, 3).join('/'));
  }
});
test('optional file module is independent of management permissions and disabled by default', () => {
  const files = BUSINESS_MODULES.find(m => m.id === 'files')!;
  const directory = BUSINESS_MODULES.find(m => m.id === 'directory')!;
  expect(allowedItems(files.items, () => true)).toHaveLength(0);
  expect(allowedItems(files.items, () => false, { files: true })).toHaveLength(1);
  expect(allowedItems(directory.items, () => false, { directory: true })).toHaveLength(0);
  expect(allowedItems(directory.items, p => p === 'samba:read', { directory: true }).length).toBeGreaterThan(0);
});
