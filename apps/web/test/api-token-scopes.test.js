import { expect, test } from 'bun:test';
import { API_TOKEN_SCOPES, selectedTokenScopes, toggleTokenScope } from '../src/lib/api-token-scopes.ts';
import { API_TOKEN_SCOPES as SERVER_SCOPES } from '../../api/src/api-tokens/api-token-scopes.ts';

test('settings offers exactly the API-supported token permissions, including create', () => {
  expect(API_TOKEN_SCOPES).toEqual(SERVER_SCOPES);
  expect(API_TOKEN_SCOPES).toContain('ticket:create');
});

test('selecting create or comment also selects read and prevents removing it', () => {
  const permissions = [...API_TOKEN_SCOPES];
  for (const write of ['ticket:create', 'ticket:comment']) {
    const selected = toggleTokenScope([], write, permissions);
    expect(selected).toEqual(['ticket:read', write]);
    expect(toggleTokenScope(selected, 'ticket:read', permissions)).toEqual(selected);
    expect(toggleTokenScope(selected, write, permissions)).toEqual(['ticket:read']);
  }
});

test('scope selection cannot grant a permission the account lacks, including stale selections', () => {
  const readOnly = ['ticket:read'];
  expect(toggleTokenScope(readOnly, 'ticket:create', readOnly)).toEqual(readOnly);
  expect(selectedTokenScopes(['ticket:read', 'ticket:create', 'user:manage'], readOnly)).toEqual(readOnly);
  expect(selectedTokenScopes([...API_TOKEN_SCOPES], [])).toEqual([]);
  expect(toggleTokenScope(['ticket:read'], 'ticket:read', readOnly)).toEqual([]);
});
