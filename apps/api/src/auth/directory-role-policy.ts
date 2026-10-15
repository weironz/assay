import type { SystemRoleName } from './role-policy';

// Authentication alone grants no business role. Administrator stays a manual grant.
export const DIRECTORY_MAPPABLE_ROLES = ['requester', 'handler', 'supervisor', 'ticket_viewer_all', 'asset_manager', 'inventory_manager', 'cop_viewer', 'samba_manager'] as const;

export function directoryRolesForGroups(mappings: { groupSid: string; roleName: string }[], groupSids: string[]): SystemRoleName[] {
  const groups = new Set(groupSids);
  return [...new Set(mappings.filter(mapping => groups.has(mapping.groupSid)).map(mapping => mapping.roleName)
    .filter((role): role is typeof DIRECTORY_MAPPABLE_ROLES[number] => (DIRECTORY_MAPPABLE_ROLES as readonly string[]).includes(role)))];
}
