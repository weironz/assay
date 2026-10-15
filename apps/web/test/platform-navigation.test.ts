import { expect, test } from 'bun:test';
import { BUSINESS_MODULES, PLATFORM_MODULE, activeMenuItem, allowedItems, moduleForPath } from '../src/lib/business-navigation';

test('platform navigation respects each permission and does not expose a landing page to ordinary requesters', () => {
  expect(allowedItems(PLATFORM_MODULE.items, () => false)).toHaveLength(0);
  const directory = allowedItems(PLATFORM_MODULE.items, p => p === 'samba:read').map(i => i.to);
  expect(directory).toEqual([]);
  expect(directory).not.toContain('/users');
  expect(directory).not.toContain('/organization');
  expect(allowedItems(PLATFORM_MODULE.items, p => p === 'user:manage').map(i => i.to)).toEqual(['/platform', '/directory-settings', '/users']);
});
test('directory deep links share the file management sidebar', () => {
  const directory = BUSINESS_MODULES.find(m => m.id === 'files')!;
  for (const path of ['/samba/users/abc', '/samba/groups/def', '/samba/shares/finance']) {
    expect(moduleForPath(path)?.id).toBe('files');
    expect(activeMenuItem(directory.items, path, new URLSearchParams())).toBe(path.split('/').slice(0, 3).join('/'));
  }
});
test('optional file module is independent of management permissions and disabled by default', () => {
  const files = BUSINESS_MODULES.find(m => m.id === 'files')!;
  const directory = BUSINESS_MODULES.find(m => m.id === 'files')!;
  expect(allowedItems(files.items, () => true)).toHaveLength(0);
  expect(allowedItems(files.items, () => false, { files: true })).toHaveLength(1);
  expect(allowedItems(directory.items, () => false, { directory: true })).toHaveLength(0);
  expect(allowedItems(directory.items, p => p === 'samba:read', { directory: true }).length).toBeGreaterThan(0);
});

test('file management follows the other business modules and supports both file and management routes', () => {
  expect(BUSINESS_MODULES.map(m => m.id)).toEqual(['tickets', 'assets', 'spares', 'files']);
  expect(moduleForPath('/files')?.id).toBe('files');
  expect(moduleForPath('/directory-settings')?.id).toBe('platform');
  const items = BUSINESS_MODULES.at(-1)!.items;
  expect(allowedItems(items, () => false, { files: true, directory: true }).map(i => i.to)).toEqual(['/files']);
  expect(allowedItems(items, () => true, { directory: true }).some(i => i.to === '/files')).toBe(false);
});

test('a file-only employee has no ticket, asset or inventory navigation until explicitly authorized', () => {
  const modules = (permissions: string[]) => BUSINESS_MODULES.filter(module => allowedItems(module.items, p => permissions.includes(p), { files: true, directory: true }).length).map(module => module.id);
  expect(modules([])).toEqual(['files']);
  expect(modules(['ticket:create', 'ticket:read'])).toEqual(['tickets', 'files']);
  expect(modules(['inventory:read'])).toEqual(['spares', 'files']);
  expect(modules([])).toEqual(['files']);
});
