const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
// SessionGuard imports AuthService. This fixture supplies authentication itself;
// do not start a deployment Redis connection just by loading that module.
const redisModule = require.resolve('../dist/auth/auth-redis');
require.cache[redisModule] = { id: redisModule, filename: redisModule, loaded: true, exports: { authRedis: {} } };
const { TicketsService } = require('../dist/tickets/tickets.service');
const { TicketSharesService } = require('../dist/ticket-shares/ticket-shares.service');
const { MetaController } = require('../dist/tickets/meta.controller');
const { ListTicketsQuery } = require('../dist/tickets/dto');
const { StatsModule } = require('../dist/stats/stats.module');
const [StatsController] = Reflect.getMetadata('controllers', StatsModule);
const { PrismaService } = require('../dist/prisma/prisma.service');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { PermissionsGuard } = require('../dist/auth/permissions.guard');
const { SessionGuard } = require('../dist/auth/session.guard');

test('environment/SLA/date filters intersect ticket visibility; list and count use exactly the same scope', async () => {
  const queries = [];
  const service = new TicketsService({ ticket: {
    findMany: async args => { queries.push(args); return []; },
    count: async args => { queries.push(args); return 0; },
  } }, {}, {}, {});
  const user = { id: 'requester', roles: ['requester'], permissions: ['ticket:read'] };
  const result = await service.list(user, { datacenterId: 'bkk', assigneeId: '__none__', slaState: 'overdue', createdFrom: '2026-10-19T16:00:00Z', createdTo: '2026-10-20T16:00:00Z', keyword: 'GPU', page: 2, pageSize: 20 });
  const [list, count] = queries;
  assert.equal(list.where, count.where);
  assert.deepEqual(list.where.AND[0].OR[0], { requesterId: 'requester' });
  assert.ok(list.where.AND.some(item => item.datacenterId === 'bkk'));
  assert.ok(list.where.AND.some(item => item.assigneeId === null));
  assert.ok(list.where.AND.some(item => item.slaDueAt?.lt && item.status.notIn.includes('PENDING')));
  assert.ok(list.where.AND.some(item => item.createdAt?.gte instanceof Date && item.createdAt.lt instanceof Date));
  assert.deepEqual(list.include.datacenter, { select: { id: true, name: true } });
  assert.equal(list.skip, 20); assert.equal(result.page, 2);
  await service.list(user, { datacenterId: '__none__', slaState: 'paused' });
  assert.ok(queries[2].where.AND.some(item => item.datacenterId === null));
  assert.ok(queries[2].where.AND.some(item => item.status === 'PENDING'));
  const before = queries.length;
  await assert.rejects(service.list(user, { createdFrom: '2026-11-01', createdTo: '2026-10-01' }), { status: 400 });
  assert.equal(queries.length, before);
});

test('filter DTO rejects invalid SLA or dates instead of silently ignoring them', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  for (const query of [{ slaState: 'bad' }, { createdFrom: 'bad' }, { createdTo: '2026-99-99' }]) {
    await assert.rejects(pipe.transform(query, { type: 'query', metatype: ListTicketsQuery }), { status: 400 });
  }
  const valid = await pipe.transform({ datacenterId: 'bkk', slaState: 'within', createdFrom: '2026-10-20T00:00:00Z' }, { type: 'query', metatype: ListTicketsQuery });
  assert.equal(valid.datacenterId, 'bkk'); assert.equal(valid.slaState, 'within');
});

test('dashboard overdue count agrees with the list and does not count a paused SLA', async () => {
  const conditions = [];
  const controller = new StatsController({ ticket: { groupBy: async () => [], count: async ({ where }) => { conditions.push(where); return 0; } }, notification: { count: async () => 0 } });
  await controller.overview({ id: 'user', roles: ['requester'], permissions: ['ticket:read'] });
  const overdue = conditions.find(where => where.slaDueAt);
  assert.ok(overdue.status.notIn.includes('PENDING'));
});

test('share creation needs no link name and still hashes its capability token', async () => {
  let saved;
  const service = new TicketSharesService({
    ticket: { findUnique: async () => ({ requesterId: 'owner', assigneeId: null }) },
    ticketShare: { create: async ({ data }) => { saved = data; return { id: 'share-1', label: data.label, expiresAt: data.expiresAt, revokedAt: null, createdAt: new Date() }; } },
    ticketHistory: { create: async () => ({}) },
  });
  const share = await service.create({ id: 'owner', roles: ['requester'] }, 'ticket-1', { expiresInDays: 7 });
  assert.match(share.token, /^shr_/); assert.ok(saved.tokenHash); assert.notEqual(saved.tokenHash, share.token);
  assert.equal(saved.ticketId, 'ticket-1'); assert.equal(saved.createdById, 'owner');
});

test('datacenter preset HTTP routes require login, permission and the admin role; protect referenced options', async () => {
  const rows = [{ id: 'used', name: 'datazone' }];
  const coded = code => Object.assign(new Error('fixture'), { code });
  const database = {
    $queryRaw: async () => [],
    datacenter: {
      findMany: async () => rows.map(row => ({ ...row })),
      findUnique: async ({ where }) => {
        const row = rows.find(item => item.id === where.id);
        return row ? { ...row, _count: { tickets: row.id === 'used' ? 1 : 0, assets: 0, clusters: 0 } } : null;
      },
      create: async ({ data }) => { if (rows.some(row => row.name === data.name)) throw coded('P2002'); const row = { id: 'new-dc', ...data }; rows.push(row); return row; },
      update: async ({ where, data }) => { const row = rows.find(item => item.id === where.id); if (!row) throw coded('P2025'); Object.assign(row, data); return row; },
      delete: async ({ where }) => { const index = rows.findIndex(row => row.id === where.id); if (index < 0) throw coded('P2025'); return rows.splice(index, 1)[0]; },
    },
  };
  database.$transaction = fn => fn(database);
  class FixtureModule {}
  Module({ controllers: [MetaController], providers: [{ provide: PrismaService, useValue: database }] })(FixtureModule);
  const reflector = new Reflector();
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalGuards(new SessionGuard(reflector, { getUserFromRequest: async req => {
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    return { id: 'fixture', status: 'ACTIVE', roles: [cookie === 'admin' || cookie === 'admin-no-perm' ? 'admin' : 'requester'], permissions: cookie === 'reader' || cookie === 'admin-no-perm' ? [] : ['user:manage'] };
  } }), new PermissionsGuard(reflector));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const call = (method, path, cookie, body) => fetch(`${base}/api/datacenters${path}`, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call('POST', '', null, { name: 'BKK' })).status, 401);
    for (const cookie of ['reader', 'delegated', 'admin-no-perm']) assert.equal((await call('POST', '', cookie, { name: 'BKK' })).status, 403);
    assert.equal((await call('POST', '', 'admin', { name: '   ' })).status, 400);
    assert.equal((await call('POST', '', 'admin', { name: 'x'.repeat(81) })).status, 400);
    const created = await call('POST', '', 'admin', { name: ' BKK ' });
    assert.equal(created.status, 201); assert.equal((await created.json()).name, 'BKK');
    assert.equal((await call('POST', '', 'admin', { name: 'BKK' })).status, 409);
    assert.equal((await call('PATCH', '/new-dc', 'admin', { name: 'BKK-2' })).status, 200);
    const options = await (await call('GET', '', 'reader')).json();
    assert.ok(options.some(row => row.name === 'BKK-2'));
    assert.equal((await call('DELETE', '/used', 'admin')).status, 409);
    assert.equal((await call('DELETE', '/new-dc', 'admin')).status, 200);
    assert.equal((await call('DELETE', '/missing', 'admin')).status, 404);
    assert.equal(rows.length, 1);
  } finally { await app.close(); }
});
