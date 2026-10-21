import { expect, test } from 'bun:test';
import { filterRoles, toggleRoleSelection, type AssignableRole } from '../src/features/access/role-selection';
import { accessEn, accessCn, accessTw, accessTh } from '../src/features/access/strings';

const roles: AssignableRole[] = [
  { id: '1', name: 'requester', description: '提单人', permissions: ['ticket:create'] },
  { id: '2', name: 'admin', description: '管理员', permissions: ['user:manage', 'ticket:create'] },
  { id: '3', name: 'ticket_viewer_all', description: '工单观察员', permissions: ['ticket:read:all'] },
];
const describe = (role: AssignableRole) => accessEn.roles[role.name as keyof typeof accessEn.roles];

test('roles match localized labels, identifiers and actual permissions without case sensitivity', () => {
  expect(filterRoles(roles, '  ADMIN  ', [], false, describe).map(r => r.name)).toEqual(['admin']);
  expect(filterRoles(roles, '观察员', [], false, describe).map(r => r.name)).toEqual(['ticket_viewer_all']);
  expect(filterRoles(roles, 'ticket:read:all', [], false, describe).map(r => r.name)).toEqual(['ticket_viewer_all']);
  expect(filterRoles(roles, 'observer', [], false, describe).map(r => r.name)).toEqual(['ticket_viewer_all']);
  expect(filterRoles(roles, 'ADMIN user:manage', [], false, describe).map(r => r.name)).toEqual(['admin']);
});
test('selected-only and empty-result searches never mutate selected hidden roles', () => {
  const selected = ['requester', 'ticket_viewer_all'];
  expect(filterRoles(roles, '', selected, true, describe).map(r => r.name)).toEqual(selected);
  expect(filterRoles(roles, 'admin', selected, true, describe)).toEqual([]);
  expect(filterRoles(roles, 'no-match', selected, false, describe)).toEqual([]);
  expect(selected).toEqual(['requester', 'ticket_viewer_all']);
  expect(filterRoles(roles, '', [], false, describe)).toHaveLength(3);
});
test('individual toggles preserve hidden selections and do not duplicate roles', () => {
  const selected = ['requester', 'ticket_viewer_all'];
  expect(toggleRoleSelection(selected, 'admin')).toEqual([...selected, 'admin']);
  expect(toggleRoleSelection(selected, 'requester')).toEqual(['ticket_viewer_all']);
  expect(toggleRoleSelection(['admin', 'admin'], 'admin')).toEqual([]);
  expect(selected).toEqual(['requester', 'ticket_viewer_all']);
});
test('large role catalogs are searchable without losing offscreen selection', () => {
  const catalog = Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: `role_${i}`, description: `Role ${i}` }));
  expect(filterRoles(catalog, 'role_499', ['role_0'], false, r => r.description!)).toEqual([catalog[499]]);
  expect(filterRoles(catalog, '', ['role_0', 'role_499'], true, r => r.name)).toHaveLength(2);
});
test('every language provides the same role labels, summaries and controls', () => {
  for (const copy of [accessCn, accessTw, accessTh]) {
    expect(Object.keys(copy).sort()).toEqual(Object.keys(accessEn).sort());
    expect(Object.keys(copy.roles).sort()).toEqual(Object.keys(accessEn.roles).sort());
    expect(Object.keys(copy.summaries).sort()).toEqual(Object.keys(accessEn.summaries).sort());
  }
});
