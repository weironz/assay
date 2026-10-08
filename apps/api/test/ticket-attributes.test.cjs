const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { ValidationPipe } = require('@nestjs/common');
const { Prisma } = require('@prisma/client');
const { TicketsService } = require('../dist/tickets/tickets.service');
const { UpdateTicketDto } = require('../dist/tickets/dto');

const requester = { id: 'requester', roles: ['requester'], permissions: ['ticket:read', 'ticket:update'] };
const original = {
  id: 'ticket-1', requesterId: requester.id, assigneeId: 'handler', title: 'GPU failure', priority: 'HIGH',
  typeId: 'incident', categoryId: 'gpu', queueId: 'default', datacenterId: null, clusterId: 'historical-cluster',
  serialNumber: 'SN-1', contact: { phone: '12345', callTime: 'ANY', smsTime: 'NONE', emails: [] },
  status: 'IN_PROGRESS', slaDueAt: new Date('2026-12-31'), firstResponseDueAt: new Date('2026-12-30'),
  holdMs: 120000,
};
function fixture({ failAudit = false } = {}) {
  let row = structuredClone(original);
  let history = [], categories = [{ id: 'gpu', name: 'GPU 卡' }], writes = 0;
  const reference = ids => ({ findUnique: async ({ where }) => ids.includes(where.id) ? { id: where.id } : null });
  const database = {
    ticket: {
      findUnique: async () => structuredClone(row),
      update: async ({ data }) => {
        writes++;
        for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value === Prisma.JsonNull ? null : value;
        return structuredClone(row);
      },
    },
    ticketType: reference(['incident']), queue: reference(['default']), datacenter: reference(['dc-1']), cluster: reference(['historical-cluster']),
    category: {
      ...reference(['gpu']),
      findFirst: async ({ where }) => categories.find(c => c.name.toLowerCase() === where.name.equals.toLowerCase()) ?? null,
      create: async ({ data }) => { const category = { id: `custom-${categories.length}`, ...data }; categories.push(category); return category; },
    },
    ticketHistory: { create: async ({ data }) => { if (failAudit) throw new Error('audit unavailable'); history.push(data); return data; } },
  };
  const prisma = { ...database, $transaction: async operation => {
    const snapshot = { row: structuredClone(row), history: structuredClone(history), categories: structuredClone(categories), writes };
    try { return await operation(database); }
    catch (err) { ({ row, history, categories, writes } = snapshot); throw err; }
  } };
  const service = new TicketsService(prisma, {}, {}, {});
  // Exercise real update/ownership/reference/audit logic; projection is tested elsewhere.
  service.findOne = async () => structuredClone(row);
  return { service, row: () => row, history: () => history, categories: () => categories, writes: () => writes };
}

test('update DTO allows explicit null clears but rejects null required fields and malformed contact', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const transform = value => pipe.transform(value, { type: 'body', metatype: UpdateTicketDto });
  const cleared = await transform({ typeId: null, categoryId: null, queueId: null, datacenterId: null, serialNumber: null, contact: null, status: 'CLOSED' });
  assert.equal(cleared.contact, null);
  assert.equal(cleared.datacenterId, null);
  assert.equal(cleared.status, undefined);
  for (const value of [{ title: null }, { title: '' }, { priority: null }, { priority: 'BAD' }, { datacenterId: 123 }, { contact: { phone: '123', callTime: 'BAD' } }]) {
    await assert.rejects(transform(value), err => err.getStatus() === 400);
  }
});

test('requester can fill IDC/SN; only changed fields are audited and SLA, owner, state and legacy Cluster remain unchanged', async () => {
  const f = fixture();
  const result = await f.service.update(requester, 'ticket-1', { datacenterId: 'dc-1', serialNumber: ' SN-2 ' });
  assert.equal(result.datacenterId, 'dc-1'); assert.equal(result.serialNumber, 'SN-2');
  for (const field of ['typeId', 'categoryId', 'priority', 'status', 'assigneeId', 'requesterId', 'holdMs', 'slaDueAt', 'firstResponseDueAt', 'clusterId']) {
    assert.deepEqual(result[field], original[field]);
  }
  assert.deepEqual(f.history().map(h => [h.action, h.field, h.oldValue, h.newValue]), [
    ['UPDATE', 'datacenterId', null, 'dc-1'], ['UPDATE', 'serialNumber', 'SN-1', 'SN-2'],
  ]);
  assert.equal(f.history()[0].userId, requester.id);
});

test('null clears optional attributes/contact; omitted fields stay unchanged', async () => {
  const f = fixture();
  const result = await f.service.update(requester, 'ticket-1', { typeId: null, categoryId: null, queueId: null, datacenterId: null, serialNumber: ' ', contact: null });
  for (const field of ['typeId', 'categoryId', 'queueId', 'datacenterId', 'serialNumber', 'contact']) assert.equal(result[field], null);
  assert.equal(result.title, original.title); assert.equal(result.priority, original.priority);
  assert.ok(f.history().every(h => h.newValue === null));
});

test('blank title or category and nonexistent references fail before any writes', async () => {
  for (const patch of [{ title: ' ' }, { categoryName: ' ' }, ...['typeId', 'categoryId', 'queueId', 'datacenterId'].map(field => ({ [field]: 'missing' }))]) {
    const f = fixture();
    await assert.rejects(f.service.update(requester, 'ticket-1', patch), err => err.getStatus() === 400);
    assert.equal(f.writes(), 0); assert.deepEqual(f.history(), []);
  }
});

test('unrelated handler/read-all user cannot edit; assigned handler and supervisor can', async () => {
  const f = fixture();
  await assert.rejects(f.service.update({ id: 'other', roles: ['handler'], permissions: ['ticket:read:all', 'ticket:update'] }, 'ticket-1', { title: 'No' }), err => err.getStatus() === 403);
  assert.equal(f.writes(), 0);
  await f.service.update({ id: 'handler', roles: ['handler'], permissions: ['ticket:update'] }, 'ticket-1', { title: 'Assigned' });
  await f.service.update({ id: 'other', roles: ['supervisor'], permissions: ['ticket:update'] }, 'ticket-1', { priority: 'URGENT' });
  assert.equal(f.row().priority, 'URGENT');
});

test('no-op changes do not create audit noise', async () => {
  const f = fixture();
  await f.service.update(requester, 'ticket-1', { title: ' GPU failure ', serialNumber: ' SN-1 ' });
  assert.equal(f.writes(), 0); assert.deepEqual(f.history(), []);
});

test('custom category reuses known names or creates within the update transaction', async () => {
  const f = fixture();
  await f.service.update(requester, 'ticket-1', { categoryId: null, categoryName: ' gpu 卡 ' });
  assert.equal(f.row().categoryId, 'gpu'); assert.equal(f.categories().length, 1);
  await f.service.update(requester, 'ticket-1', { categoryId: null, categoryName: ' Cooling ' });
  assert.equal(f.row().categoryId, 'custom-1'); assert.equal(f.categories()[1].name, 'Cooling');
});

test('audit failure rolls back ticket and custom category together', async () => {
  const f = fixture({ failAudit: true });
  await assert.rejects(f.service.update(requester, 'ticket-1', { categoryId: null, categoryName: 'Cooling', datacenterId: 'dc-1' }), /audit unavailable/);
  assert.deepEqual(f.row(), original); assert.equal(f.categories().length, 1); assert.deepEqual(f.history(), []);
});
