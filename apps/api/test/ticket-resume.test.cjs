const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
require('reflect-metadata');
const { TicketLifecycle } = require('../dist/tickets/ticket-lifecycle');
const { TicketQueries } = require('../dist/tickets/ticket-queries');
const { WorkflowService } = require('../dist/tickets/workflow.service');
const { PrismaClient } = require('@prisma/client');

const DAY = 86_400_000;
const INT32_MAX = 2_147_483_647;
const handler = { id: 'handler', roles: ['handler'], permissions: ['ticket:read', 'ticket:transition'] };

function fixture({ days = 53, accumulated = 0n, firstResponseAt = null, conflict = false } = {}) {
  let ticket = {
    id: 'ticket-1', ticketNo: 'REGRESSION-1', title: 'Long hold', status: 'PENDING',
    requesterId: 'requester', assigneeId: handler.id, typeId: null,
    holdMs: accumulated, holdStartedAt: new Date(Date.now() - days * DAY),
    firstResponseAt, firstResponseDueAt: new Date(Date.now() - days * DAY + 60_000),
    slaDueAt: new Date(Date.now() - days * DAY + DAY), participants: [], messages: [],
  };
  const before = structuredClone(ticket);
  const history = [], scheduled = [];
  const prisma = {
    ticket: {
      findUnique: async () => structuredClone(ticket),
      updateMany: async ({ where, data }) => {
        if (conflict || where.status !== ticket.status) return { count: 0 };
        const { holdMs, ...rest } = data;
        ticket = { ...ticket, ...rest, holdMs: ticket.holdMs + holdMs.increment };
        return { count: 1 };
      },
    },
    ticketHistory: { create: async ({ data }) => history.push(data) },
    ticketParticipant: { findMany: async () => [] },
  };
  prisma.$transaction = async work => work(prisma);
  const lifecycle = new TicketLifecycle(prisma, new WorkflowService(), {}, {
    schedule: async (...args) => scheduled.push(args),
  });
  return { lifecycle, prisma, before, current: () => ticket, history, scheduled };
}

test('resume after 53 days preserves elapsed time and shifts both outstanding SLA deadlines exactly once', async () => {
  const f = fixture();
  const start = Date.now();
  await f.lifecycle.transition(handler, 'ticket-1', 'resume');
  const row = f.current();
  const elapsed = Number(row.holdMs);
  assert.ok(elapsed > INT32_MAX);
  assert.ok(elapsed >= start - f.before.holdStartedAt.getTime());
  assert.ok(elapsed <= Date.now() - f.before.holdStartedAt.getTime());
  assert.equal(row.status, 'IN_PROGRESS');
  assert.equal(row.holdStartedAt, null);
  assert.equal(row.firstResponseDueAt - f.before.firstResponseDueAt, elapsed);
  assert.equal(row.slaDueAt - f.before.slaDueAt, elapsed);
  assert.deepEqual(f.scheduled.map(args => args.slice(0, 2)), [['ticket-1', 'response'], ['ticket-1', 'resolve']]);
  assert.equal(f.history.length, 1);
  await assert.rejects(f.lifecycle.transition(handler, 'ticket-1', 'resume'), { status: 409 });
  assert.equal(f.current().holdMs, row.holdMs);
  assert.equal(f.history.length, 1);
});

test('multiple short holds can accumulate past INT32; a completed first response is not shifted or rescheduled', async () => {
  const f = fixture({ days: 2, accumulated: BigInt(INT32_MAX - DAY), firstResponseAt: new Date() });
  await f.lifecycle.transition(handler, 'ticket-1', 'resume');
  assert.ok(f.current().holdMs > BigInt(INT32_MAX));
  assert.equal(f.current().firstResponseDueAt.getTime(), f.before.firstResponseDueAt.getTime());
  assert.deepEqual(f.scheduled.map(args => args.slice(0, 2)), [['ticket-1', 'resolve']]);
});

test('resume still enforces assignee permission and concurrent status checks without duplicate effects', async () => {
  const f = fixture();
  await assert.rejects(f.lifecycle.transition({ ...handler, id: 'other' }, 'ticket-1', 'resume'), { status: 403 });
  assert.equal(f.current().status, 'PENDING');
  const c = fixture({ conflict: true });
  await assert.rejects(c.lifecycle.transition(handler, 'ticket-1', 'resume'), { status: 409 });
  assert.equal(c.history.length, 0);
  assert.equal(c.scheduled.length, 0);
});

test('long accumulated holds remain JSON numbers in ticket details and lists', async () => {
  const f = fixture({ accumulated: 5_000_000_000n });
  f.prisma.ticket.findMany = async () => [f.current()];
  f.prisma.ticket.count = async () => 1;
  const queries = new TicketQueries(f.prisma, new WorkflowService());
  const detail = JSON.parse(JSON.stringify(await queries.findOne(handler, 'ticket-1')));
  const list = JSON.parse(JSON.stringify(await queries.list(handler, {})));
  assert.equal(detail.holdMs, 5_000_000_000);
  assert.equal(list.items[0].holdMs, 5_000_000_000);
  assert.deepEqual(detail.availableActions, ['resume']);
});

const url = process.env.TICKET_LIFECYCLE_TEST_DATABASE_URL;
test('PostgreSQL migration preserves old values and real long-hold resume persists, audits, schedules and serializes', { skip: !url }, async () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const suffix = randomUUID();
  let person;
  const tickets = [];
  try {
    const columns = await db.$queryRaw`SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tickets' AND column_name = 'hold_ms'`;
    assert.equal(columns[0].data_type, 'bigint');
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE resume_migration_check (hold_ms INTEGER NOT NULL DEFAULT 0) ON COMMIT DROP');
      await tx.$executeRawUnsafe('INSERT INTO resume_migration_check (hold_ms) VALUES (0), (2147483647)');
      const sql = readFileSync(path.join(__dirname, '../prisma/migrations/20261120030000_ticket_hold_ms_bigint/migration.sql'), 'utf8');
      await tx.$executeRawUnsafe(sql.replace('"tickets"', 'resume_migration_check'));
      assert.deepEqual(await tx.$queryRawUnsafe('SELECT hold_ms FROM resume_migration_check ORDER BY hold_ms'), [{ hold_ms: 0n }, { hold_ms: 2147483647n }]);
      await tx.$executeRawUnsafe('INSERT INTO resume_migration_check (hold_ms) VALUES (4612229581)');
    });
    person = await db.user.create({ data: { name: 'Resume regression', email: `resume-${suffix}@example.test` } });
    const user = { ...handler, id: person.id };
    for (const [index, [days, accumulated]] of [[53, 0n], [2, BigInt(INT32_MAX - DAY)]].entries()) {
      const holdStartedAt = new Date(Date.now() - days * DAY);
      const slaDueAt = new Date(holdStartedAt.getTime() + DAY);
      const row = await db.ticket.create({ data: {
        ticketNo: `resume-${suffix}-${index}`, title: 'Long hold regression', requesterId: user.id,
        assigneeId: user.id, status: 'PENDING', holdStartedAt, holdMs: accumulated,
        firstResponseDueAt: new Date(holdStartedAt.getTime() + 60_000), slaDueAt,
      } });
      tickets.push(row.id);
      const jobs = [];
      const lifecycle = new TicketLifecycle(db, new WorkflowService(), {}, { schedule: async (...args) => jobs.push(args) });
      await lifecycle.transition(user, row.id, 'resume');
      const updated = await db.ticket.findUniqueOrThrow({ where: { id: row.id } });
      assert.ok(updated.holdMs > BigInt(INT32_MAX));
      assert.equal(updated.status, 'IN_PROGRESS');
      assert.equal(updated.holdStartedAt, null);
      assert.equal(updated.slaDueAt - slaDueAt, Number(updated.holdMs - accumulated));
      assert.equal(jobs.length, 2);
      assert.equal(await db.ticketHistory.count({ where: { ticketId: row.id, field: 'status', oldValue: 'PENDING', newValue: 'IN_PROGRESS' } }), 1);
      const queries = new TicketQueries(db, new WorkflowService());
      const result = JSON.parse(JSON.stringify(await queries.findOne(user, row.id)));
      assert.equal(result.holdMs, Number(updated.holdMs));
      const list = JSON.parse(JSON.stringify(await queries.list(user, { ticketNo: row.ticketNo })));
      assert.equal(list.items[0].holdMs, result.holdMs);
    }
  } finally {
    await db.ticketHistory.deleteMany({ where: { ticketId: { in: tickets } } });
    await db.ticket.deleteMany({ where: { id: { in: tickets } } });
    if (person) await db.user.delete({ where: { id: person.id } });
    await db.$disconnect();
  }
});
