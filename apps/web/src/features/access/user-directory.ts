export interface NewUserForm {
  name: string;
  email: string;
  password: string;
  roleNames: string[];
}

export function newUserPayload(form: NewUserForm): NewUserForm {
  return { name: form.name.trim(), email: form.email.trim(), password: form.password, roleNames: [...new Set(form.roleNames)] };
}

export function invalidUserField(form: NewUserForm): 'name' | 'email' | 'password' | null {
  if (form.name.trim().length < 2) return 'name';
  if (!form.email.trim()) return 'email';
  if (form.password.length < 6) return 'password';
  return null;
}

interface SearchableUser {
  name: string;
  email: string;
  username?: string | null;
  roles: string[];
  directoryRoles?: string[];
  directoryAccount?: string | null;
}

export function filterUsers<T extends SearchableUser>(users: T[], query: string, roleLabel: (name: string) => string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return users.filter(user => {
    const roles = [...user.roles, ...(user.directoryRoles ?? [])];
    const haystack = [user.name, user.email, user.username, user.directoryAccount, ...roles, ...roles.map(roleLabel)].join(' ').toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
