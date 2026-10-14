const test = require('node:test');
const assert = require('node:assert/strict');
const { readOidcSettings, oidcDestination } = require('../src/auth/oidc-config');
const env = {
  NODE_ENV: 'production', OIDC_ENABLED: 'true', OIDC_ISSUER_URL: 'https://sso.example.test/realms/company',
  OIDC_CLIENT_ID: 'assay', OIDC_CLIENT_SECRET: 'test-only',
  AUTH_BASE_URL: 'https://assay.example.test', AUTH_TRUST_ORIGINS: 'https://assay.example.test',
};
test('OIDC is opt-in; enabled configurations fail closed on missing credentials or unsafe URLs', () => {
  assert.equal(readOidcSettings({}), null);
  for (const key of ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ISSUER_URL', 'AUTH_BASE_URL', 'AUTH_TRUST_ORIGINS']) {
    assert.throws(() => readOidcSettings({ ...env, [key]: '' }));
  }
  for (const issuer of ['http://sso.example.test', 'https://secret@sso.example.test', 'https://sso.example.test?secret=x']) {
    assert.throws(() => readOidcSettings({ ...env, OIDC_ISSUER_URL: issuer, OIDC_ALLOW_HTTP: 'true' }));
  }
  assert.throws(() => readOidcSettings({ ...env, AUTH_BASE_URL: 'http://assay.example.test' }));
  assert.throws(() => readOidcSettings({ ...env, AUTH_TRUST_ORIGINS: 'https://assay.example.test/path' }));
  assert.throws(() => readOidcSettings({ ...env, OIDC_TOKEN_AUTH_METHOD: 'none' }));
});
test('issuer-scoped identity keys survive client changes and change when the issuer changes', () => {
  const config = readOidcSettings(env);
  assert.equal(config.callbackURL, 'https://assay.example.test/api/auth/oidc/callback');
  assert.equal(config.providerId, readOidcSettings({ ...env, OIDC_CLIENT_ID: 'replacement-client' }).providerId);
  assert.notEqual(config.providerId, readOidcSettings({ ...env, OIDC_ISSUER_URL: 'https://other.example.test' }).providerId);
  assert.equal(config.autoProvision, true);
});
test('development HTTP requires explicit opt-in and a loopback IdP', () => {
  assert.throws(() => readOidcSettings({ ...env, NODE_ENV: 'development', OIDC_ISSUER_URL: 'http://localhost:9000' }));
  assert.equal(readOidcSettings({ ...env, NODE_ENV: 'development', OIDC_ISSUER_URL: 'http://localhost:9000', OIDC_ALLOW_HTTP: 'true' }).allowHTTP, true);
  assert.throws(() => readOidcSettings({ ...env, NODE_ENV: 'development', OIDC_ISSUER_URL: 'http://192.0.2.1', OIDC_ALLOW_HTTP: 'true' }));
});
test('login and linking redirects are confined to fixed pages on exact trusted origins', () => {
  const config = readOidcSettings(env);
  assert.equal(oidcDestination(config, 'https://assay.example.test/dashboard').success, 'https://assay.example.test/dashboard');
  assert.equal(oidcDestination(config, 'https://assay.example.test/settings', true).success, 'https://assay.example.test/settings?tab=security&oidc_linked=1');
  for (const url of ['https://attacker.test/dashboard', 'https://assay.example.test/dashboard?next=https://attacker.test', 'https://assay.example.test/logout', 'https://assay.example.test/dashboard#token', 'https://secret@assay.example.test/dashboard']) {
    assert.throws(() => oidcDestination(config, url));
  }
});
