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

test('comment checkbox toggles from the default read selection without duplicate scopes', () => {
  // Regression: the old onChange appended ticket:read instead of ticket:comment.
  const permissions = [...API_TOKEN_SCOPES];
  let selected = ['ticket:read'];
  for (let click = 0; click < 6; click++) {
    selected = toggleTokenScope(selected, 'ticket:comment', permissions);
    expect(selected).toEqual(click % 2 === 0 ? ['ticket:read', 'ticket:comment'] : ['ticket:read']);
    expect(new Set(selected).size).toBe(selected.length);
  }
  selected = toggleTokenScope(['ticket:read', 'ticket:create'], 'ticket:comment', permissions);
  expect(selected).toEqual(['ticket:read', 'ticket:create', 'ticket:comment']);
  expect(toggleTokenScope(selected, 'ticket:comment', permissions)).toEqual(['ticket:read', 'ticket:create']);
});

test('scope selection cannot grant a permission the account lacks, including stale selections', () => {
  const readOnly = ['ticket:read'];
  expect(toggleTokenScope(readOnly, 'ticket:create', readOnly)).toEqual(readOnly);
  expect(selectedTokenScopes(['ticket:read', 'ticket:create', 'user:manage'], readOnly)).toEqual(readOnly);
  expect(selectedTokenScopes([...API_TOKEN_SCOPES], [])).toEqual([]);
  expect(toggleTokenScope(['ticket:read'], 'ticket:read', readOnly)).toEqual([]);
});
