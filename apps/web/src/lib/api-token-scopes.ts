export const API_TOKEN_SCOPES = ['ticket:read', 'ticket:create', 'ticket:comment'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export function selectedTokenScopes(scopes: string[], permissions: string[]): ApiTokenScope[] {
  const selected = API_TOKEN_SCOPES.filter((scope) => scopes.includes(scope) && permissions.includes(scope));
  if (!permissions.includes('ticket:read')) return [];
  if (selected.some((scope) => scope !== 'ticket:read') && !selected.includes('ticket:read')) {
    selected.unshift('ticket:read');
  }
  return selected;
}

export function toggleTokenScope(scopes: string[], scope: ApiTokenScope, permissions: string[]): ApiTokenScope[] {
  const current = selectedTokenScopes(scopes, permissions);
  if (!permissions.includes(scope) || !permissions.includes('ticket:read')) return current;
  if (scope === 'ticket:read' && current.some((value) => value !== 'ticket:read')) return current;
  return selectedTokenScopes(current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope], permissions);
}
