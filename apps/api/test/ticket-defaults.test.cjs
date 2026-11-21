const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');
const { TicketEditor } = require('../dist/tickets/ticket-editor');

const url = process.env.TICKET_LIFECYCLE_TEST_DATABASE_URL;

test('new tickets use medium priority, incident SLA and one default queue while preserving explicit priority and type', { skip: !url }, async () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const tag = `ticket-defaults-${randomUUID()}`;
  const jobs = [];
  const editor = new TicketEditor(db, { schedule: async (...args) => jobs.push(args) });
  let user, customType;
  try {
    user = await db.user.create({ data: { name: tag, email: `${tag}@example.test` } });
    const body = '<p>Ticket fixture</p>';
    const ids = await Promise.all([
      editor.create(user, { title: `${tag} first`, body }),
      editor.create(user, { title: `${tag} second`, body }),
    ]);
    const defaults = await db.ticket.findMany({
      where: { id: { in: ids } }, include: { queue: true, type: true },
    });
    assert.equal(defaults.length, 2);
    assert.equal(defaults[0].queueId, defaults[1].queueId);
    assert.equal(defaults[0].typeId, defaults[1].typeId);
    for (const row of defaults) {
      assert.equal(row.priority, 'MEDIUM');
      assert.equal(row.queue.name, '默认队列');
      assert.equal(row.type.name, '故障');
      assert.equal(row.firstResponseDueAt - row.createdAt, row.type.slaResponseMin * 60_000);
      assert.equal(row.slaDueAt - row.createdAt, row.type.slaResolveMin * 60_000);
      assert.deepEqual(jobs.filter(([id]) => id === row.id).map(([, kind, due]) => [kind, due]), [
        ['response', row.firstResponseDueAt], ['resolve', row.slaDueAt],
      ]);
    }

    customType = await db.ticketType.create({ data: { name: tag, slaResponseMin: 17, slaResolveMin: 225 } });
    const id = await editor.create(user, { title: `${tag} explicit`, body, priority: 'HIGH', typeId: customType.id });
    const explicit = await db.ticket.findUniqueOrThrow({ where: { id } });
    assert.equal(explicit.priority, 'HIGH');
    assert.equal(explicit.typeId, customType.id);
    assert.equal(explicit.queueId, defaults[0].queueId);
    assert.equal(explicit.slaDueAt - explicit.createdAt, 225 * 60_000);
  } finally {
    try {
      if (user) {
        await db.ticket.deleteMany({ where: { requesterId: user.id } });
        await db.user.delete({ where: { id: user.id } });
      }
      if (customType) await db.ticketType.delete({ where: { id: customType.id } });
    } finally { await db.$disconnect(); }
  }
});
