export interface AssignableRole {
  id: string;
  name: string;
  description: string | null;
  permissions?: string[];
}

/** Filtering never changes the selection, including roles hidden by a search. */
export function filterRoles(
  roles: AssignableRole[], query: string, selected: string[], selectedOnly: boolean,
  describe: (role: AssignableRole) => string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return roles.filter(role => {
    if (selectedOnly && !selected.includes(role.name)) return false;
    const text = [role.name, role.description, describe(role), ...(role.permissions ?? [])].join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function toggleRoleSelection(selected: string[], name: string) {
  return selected.includes(name) ? selected.filter(value => value !== name) : [...new Set([...selected, name])];
}
