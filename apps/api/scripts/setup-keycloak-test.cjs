const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const directory = path.resolve(process.argv[2] || '.oidc-test');
if (/[\r\n]/.test(directory)) throw new Error('Invalid runtime directory');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = path.join(directory, 'compose.env');
if (fs.existsSync(file)) {
  console.log('Existing test configuration retained:', directory);
  process.exit(0);
}
const secret = () => randomBytes(32).toString('base64url');
const clientSecret = secret(), adminPassword = secret(), localPassword = secret();
const users = ['new', 'local', 'mfa', 'unverified', 'outside'].map(kind => ({
  kind, username: `assay-${kind}`,
  email: `assay-${kind}@${kind === 'outside' ? 'other.test' : 'example.test'}`,
  password: secret(),
}));
const write = (name, contents) => fs.writeFileSync(path.join(directory, name), contents, { mode: 0o600 });
write('realm.json', JSON.stringify({
  realm: 'assay-test', enabled: true, sslRequired: 'none', registrationAllowed: false,
  roles: { realm: [{ name: 'external-admin-fixture' }] },
  clients: [{
    clientId: 'assay', enabled: true, protocol: 'openid-connect', publicClient: false,
    secret: clientSecret, standardFlowEnabled: true, directAccessGrantsEnabled: false,
    redirectUris: ['http://localhost:5190/api/auth/oidc/callback'], webOrigins: ['http://localhost:5190'],
    attributes: { 'pkce.code.challenge.method': 'S256' },
    defaultClientScopes: ['web-origins', 'acr', 'profile', 'roles', 'email'],
  }],
  users: users.map(user => ({
    username: user.username, email: user.email, enabled: true, emailVerified: user.kind !== 'unverified',
    firstName: 'Assay', lastName: `${user.kind} fixture`, requiredActions: [],
    realmRoles: ['external-admin-fixture'],
    credentials: [{ type: 'password', value: user.password, temporary: false }],
  })),
}, null, 2) + '\n');
write('compose.env', [
  `OIDC_TEST_RUNTIME_DIR=${directory}`,
  `KEYCLOAK_ADMIN_PASSWORD=${adminPassword}`,
  `KEYCLOAK_DATABASE_PASSWORD=${secret()}`,
  `ASSAY_TEST_DATABASE_PASSWORD=${secret()}`,
  'KEYCLOAK_PORT=8180', 'ASSAY_TEST_POSTGRES_PORT=5434', 'ASSAY_TEST_REDIS_PORT=6382',
].join('\n') + '\n');
const env = Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
}));
write('assay.env', [
  'NODE_ENV=development',
  `DATABASE_URL=postgresql://assay_test:${env.ASSAY_TEST_DATABASE_PASSWORD}@127.0.0.1:5434/assay_keycloak_oidc_test?schema=public`,
  'REDIS_URL=redis://127.0.0.1:6382', 'REDIS_HOST=127.0.0.1', 'REDIS_PORT=6382',
  'API_PORT=3190', 'AUTH_BASE_URL=http://localhost:5190', 'AUTH_TRUST_ORIGINS=http://localhost:5190',
  `AUTH_SECRET=${secret()}`, 'APP_URL=http://localhost:5190',
  'OIDC_ENABLED=true', 'OIDC_ALLOW_HTTP=true', 'OIDC_ISSUER_URL=http://localhost:8180/realms/assay-test',
  'OIDC_CLIENT_ID=assay', `OIDC_CLIENT_SECRET=${clientSecret}`, 'OIDC_DISPLAY_NAME=Keycloak Test',
  'OIDC_AUTO_PROVISION=true', 'OIDC_EMAIL_DOMAINS=example.test', 'OIDC_TOKEN_AUTH_METHOD=client_secret_basic',
  'REQUIRE_EMAIL_VERIFICATION=false', 'SMTP_HOST=', 'STORAGE_DRIVER=local',
  `STORAGE_LOCAL_DIR=${path.join(directory, 'storage')}`,
  'ADMIN_EMAIL=assay-admin@example.test', `ADMIN_PASSWORD=${secret()}`, 'ADMIN_NAME=OIDC test admin',
].join('\n') + '\n');
write('fixtures.json', JSON.stringify({ users, localPassword, adminPassword }, null, 2) + '\n');
console.log('Generated private test configuration:', directory);
console.log('Credentials and imported realm are stored locally; no credential values are printed.');
