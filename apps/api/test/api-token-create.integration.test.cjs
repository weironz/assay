const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, unlinkSync } = require('node:fs');
require('reflect-metadata');

// Test real Nest routes, DTO validation, Bearer lookup and both guards without
// sharing credentials, accounts, Redis or database state with a deployment.
const cache = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
cache('../dist/auth/auth-redis', { authRedis: {} });
cache('../dist/auth/session-epoch', { assertSessionEpoch: async () => {} });
cache('../dist/auth/auth', { auth: { api: {
  getSession: async ({ headers }) => headers.get('cookie') === 'test-session'
    ? { user: { id: 'requester-1' }, session: { token: 'test-session' } } : null,
} } });

const { NestFactory, Reflector } = require('@nestjs/core');
const { Module, ValidationPipe, UnauthorizedException } = require('@nestjs/common');
const { AuthService } = require('../dist/auth/auth.service');
const { SessionGuard } = require('../dist/auth/session.guard');
const { PermissionsGuard } = require('../dist/auth/permissions.guard');
const { SYSTEM_ROLE_PERMISSIONS } = require('../dist/auth/role-policy');
const { ApiTokensController } = require('../dist/api-tokens/api-tokens.controller');
const { ApiTokensService } = require('../dist/api-tokens/api-tokens.service');
const { TicketsController } = require('../dist/tickets/tickets.controller');
const { TicketsService } = require('../dist/tickets/tickets.service');
const { AttachmentsController } = require('../dist/attachments/attachments.controller');
const { AttachmentsService } = require('../dist/attachments/attachments.service');
const { StepUpService } = require('../dist/auth/step-up.service');

test('REST Token creation scope allows ticket creation and draft upload without bypassing account permissions', async (t) => {
  const previous = process.env.PRIVILEGED_MFA_MODE;
  process.env.PRIVILEGED_MFA_MODE = 'optional';
  const role = { name: 'requester', permissions: SYSTEM_ROLE_PERMISSIONS.requester.map(code => ({ permission: { code } })) };
  const user = {
    id: 'requester-1', email: 'test@example.test', name: 'Requester', username: null, image: null,
    status: 'ACTIVE', emailVerified: true, twoFactorEnabled: false, defaultContact: null, roles: [{ role }],
  };
  const rows = [];
  let writes = 0;
  const prisma = {
    user: { findUnique: async () => user },
    apiToken: {
      create: async ({ data }) => { const row = { id: `token-${rows.length}`, revokedAt: null, ...data }; rows.push(row); return { ...row }; },
      findUnique: async ({ where }) => { const row = rows.find(r => r.tokenHash === where.tokenHash); return row ? { ...row, user } : null; },
      findFirst: async ({ where }) => rows.find(r => r.id === where.id && r.userId === where.userId) ?? null,
      update: async ({ where, data }) => Object.assign(rows.find(r => r.id === where.id), data),
    },
  };
  const tokens = new ApiTokensService(prisma);
  const authService = new AuthService(prisma, tokens);
  const reflector = new Reflector();
  class TestModule {}
  Module({
    controllers: [TicketsController, ApiTokensController, AttachmentsController],
    providers: [
      { provide: ApiTokensService, useValue: tokens },
      { provide: TicketsService, useValue: { create: async (principal, dto) => {
        writes++;
        return { id: 'ticket-1', ticketNo: 'WO-TEST-0001', requesterId: principal.id, ...dto };
      } } },
      { provide: AttachmentsService, useValue: { uploadDraft: async (principal, file) => {
        try { assert.equal(readFileSync(file.path, 'utf8'), 'draft'); }
        finally { unlinkSync(file.path); }
        return { id: 'draft-1', uploaderId: principal.id };
      } } },
      { provide: StepUpService, useValue: { consume: async (_req, principal) => {
        if (principal.authType !== 'session') throw new UnauthorizedException('session required');
      } } },
    ],
  })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalGuards(new SessionGuard(reflector, authService), new PermissionsGuard(reflector));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (path, headers, body) => fetch(`${base}/api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const issue = async scopes => {
    const response = await request('/me/api-tokens', { cookie: 'test-session' }, { name: 'test', scopes });
    assert.equal(response.status, 201);
    return response.json();
  };
  const ticket = { title: 'B300 issue', body: '<p>Details</p>', priority: 'HIGH', attachmentIds: ['draft-1'] };
  const bearer = token => ({ authorization: `Bearer ${token}` });
  try {
    let created;
    await t.test('create scope is accepted, deduplicated and includes read; uploads and creation use token owner', async () => {
      created = await issue(['ticket:create', 'ticket:create']);
      assert.deepEqual(created.scopes, ['ticket:read', 'ticket:create']);
      const form = new FormData();
      form.append('file', new Blob(['draft'], { type: 'text/plain' }), 'proof.txt');
      const upload = await fetch(`${base}/api/uploads`, { method: 'POST', headers: bearer(created.token), body: form });
      assert.equal(upload.status, 201);
      assert.equal((await upload.json()).uploaderId, user.id);
      const result = await request('/tickets', bearer(created.token), { ...ticket, requesterId: 'someone-else' });
      assert.equal(result.status, 201);
      const data = await result.json();
      assert.equal(data.requesterId, user.id);
      assert.deepEqual(data.attachmentIds, ['draft-1']);
      assert.equal(writes, 1);
    });
    await t.test('read and comment tokens cannot create or upload drafts; rotation keeps legacy scopes', async () => {
      for (const scopes of [['ticket:read'], ['ticket:comment']]) {
        const issued = await issue(scopes);
        assert.equal((await request('/tickets', bearer(issued.token), ticket)).status, 403);
        assert.equal((await request('/uploads', bearer(issued.token), {})).status, 403);
      }
      const legacy = await issue(['ticket:read']);
      const rotated = await request(`/me/api-tokens/${legacy.id}/rotate`, { cookie: 'test-session' }, {});
      assert.equal(rotated.status, 201);
      const replacement = await rotated.json();
      assert.deepEqual(replacement.scopes, ['ticket:read']);
      assert.equal((await request('/tickets', bearer(replacement.token), ticket)).status, 403);
    });
    await t.test('role changes are applied on each request and token issuance rejects missing account permissions', async () => {
      const original = role.permissions;
      role.permissions = original.filter(p => p.permission.code !== 'ticket:create');
      try {
        assert.equal((await request('/tickets', bearer(created.token), ticket)).status, 403);
        const before = rows.length;
        assert.equal((await request('/me/api-tokens', { cookie: 'test-session' }, { name: 'test', scopes: ['ticket:create'] })).status, 403);
        assert.equal(rows.length, before);
      } finally { role.permissions = original; }
    });
    await t.test('invalid scopes, disabled accounts, expiry, revocation and token-to-token issuance fail closed', async () => {
      assert.equal((await request('/me/api-tokens', { cookie: 'test-session' }, { name: 'test', scopes: ['user:manage'] })).status, 400);
      assert.equal((await request('/me/api-tokens', bearer(created.token), { name: 'test', scopes: ['ticket:create'] })).status, 401);
      user.status = 'DISABLED';
      assert.equal((await request('/tickets', bearer(created.token), ticket)).status, 401);
      user.status = 'ACTIVE';
      const row = rows.find(r => r.id === created.id);
      row.expiresAt = new Date(Date.now() - 1000);
      assert.equal((await request('/tickets', bearer(created.token), ticket)).status, 401);
      row.expiresAt = null;
      row.revokedAt = new Date();
      assert.equal((await request('/tickets', bearer(created.token), ticket)).status, 401);
      assert.equal(writes, 1, 'denied requests must not create tickets');
    });
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.PRIVILEGED_MFA_MODE;
    else process.env.PRIVILEGED_MFA_MODE = previous;
  }
});
