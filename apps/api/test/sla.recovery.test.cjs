const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { SlaService } = require('../dist/sla/sla.service');
const { SlaProcessor } = require('../dist/sla/sla.processor');

const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 60_000);

function queueMock() {
  const jobs = new Map();
  return {
    jobs,
    async getJob(id) { return jobs.get(id); },
    async add(_name, data, opts) {
      if (jobs.has(opts.jobId)) return jobs.get(opts.jobId);
      const job = {
        data, opts,
        async getState() { return 'delayed'; },
        async remove() {
          if (await this.getState() === 'active') throw new Error('job is locked');
          jobs.delete(opts.jobId);
        },
      };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
}

test('reconciliation recreates missing deadlines once and skips completed receipts', async () => {
  const queue = queueMock();
  const prisma = {
    ticket: { async findMany() { return [
      { id: 'a', firstResponseDueAt: past, firstResponseAt: null, slaDueAt: future },
      { id: 'b', firstResponseDueAt: past, firstResponseAt: past, slaDueAt: past },
    ]; } },
    ticketHistory: { async findMany() { return [
      { ticketId: 'b', field: 'sla_resolve', oldValue: past.toISOString() },
    ]; } },
  };
  const service = new SlaService(queue, prisma);
  await service.reconcile();
  await service.reconcile();
  assert.deepEqual([...queue.jobs.keys()].sort(), ['a-resolve', 'a-response']);
  assert.equal(queue.jobs.get('a-response').opts.attempts, 5);
  assert.deepEqual(queue.jobs.get('a-response').opts.backoff, { type: 'exponential', delay: 5000 });
  assert.equal(queue.jobs.get('a-response').opts.removeOnFail, false);
});

test('a failed old deadline is retained while a new deadline is scheduled', async () => {
  const queue = queueMock();
  const service = new SlaService(queue, {
    ticket: { async findUnique() { return { firstResponseDueAt: null, slaDueAt: past }; } },
  });
  await service.schedule('a', 'resolve', past);
  const failed = queue.jobs.get('a-resolve');
  failed.getState = async () => 'failed';
  await service.cancel('a', 'resolve');
  assert.equal(queue.jobs.get('a-resolve'), failed);
  await service.schedule('a', 'resolve', future);
  assert.equal(queue.jobs.get('a-resolve'), failed);
  assert.ok(queue.jobs.has(`a-resolve-${future.getTime()}`));
});

test('reconciliation recovers a failed job for the same deadline, then stops after two waves', async () => {
  const queue = queueMock();
  const service = new SlaService(queue, {
    ticket: { async findMany() { return [
      { id: 'a', firstResponseDueAt: null, firstResponseAt: past, slaDueAt: past },
    ]; } },
    ticketHistory: { async findMany() { return []; } },
  });
  const errors = [];
  service.logger.error = (message) => errors.push(message);
  await service.schedule('a', 'resolve', past);
  queue.jobs.get('a-resolve').getState = async () => 'failed';

  await service.reconcile();
  const firstRecoveryId = `a-resolve-${past.getTime()}`;
  assert.ok(queue.jobs.has(firstRecoveryId), 'same-deadline failure must create a recovery job');
  assert.equal(queue.jobs.get(firstRecoveryId).opts.attempts, 5);
  queue.jobs.get(firstRecoveryId).getState = async () => 'failed';

  await service.reconcile();
  const secondRecoveryId = `${firstRecoveryId}-2`;
  assert.ok(queue.jobs.has(secondRecoveryId), 'failed alternate ID must not block recovery');
  queue.jobs.get(secondRecoveryId).getState = async () => 'failed';
  await service.reconcile();
  await service.reconcile();
  assert.deepEqual([...queue.jobs.keys()].sort(),
    ['a-resolve', firstRecoveryId, secondRecoveryId].sort(), 'recovery must be bounded');
  assert.equal(errors.length, 1, 'exhaustion should be logged once across repeated scans');
});

test('two instances create one deterministic recovery job', async () => {
  const queue = queueMock();
  const prisma = {
    ticket: { async findMany() { return [
      { id: 'a', firstResponseDueAt: null, firstResponseAt: past, slaDueAt: past },
    ]; } },
    ticketHistory: { async findMany() { return []; } },
  };
  const first = new SlaService(queue, prisma);
  const second = new SlaService(queue, prisma);
  await first.schedule('a', 'resolve', past);
  queue.jobs.get('a-resolve').getState = async () => 'failed';
  await Promise.all([first.reconcile(), second.reconcile()]);
  assert.deepEqual([...queue.jobs.keys()].sort(),
    ['a-resolve', `a-resolve-${past.getTime()}`].sort());
});

test('cancel removes queued recovery jobs while retaining failed jobs', async () => {
  const queue = queueMock();
  const service = new SlaService(queue, {
    ticket: { async findUnique() { return { firstResponseDueAt: null, slaDueAt: past }; } },
  });
  await service.schedule('a', 'resolve', past);
  queue.jobs.get('a-resolve').getState = async () => 'failed';
  await service.schedule('a', 'resolve', past);
  const recoveryId = `a-resolve-${past.getTime()}`;
  assert.ok(queue.jobs.has(recoveryId));
  await service.cancel('a', 'resolve');
  assert.ok(queue.jobs.has('a-resolve'));
  assert.equal(queue.jobs.has(recoveryId), false);
});

test('unassigned response breach alerts active administrators once', async () => {
  const { processor, history, notifications } = processorFixture({ assigneeId: null });
  const job = { data: { ticketId: 'a', kind: 'response', dueAt: past.toISOString() } };
  await processor.process(job);
  await processor.process(job);
  assert.deepEqual(notifications.map((item) => item.userId), ['admin']);
  assert.equal(history.filter((item) => item.field === 'sla_response').length, 1);
});

test('legacy receipt cannot swallow a resumed deadline during reconciliation', async () => {
  const queue = queueMock();
  const receiptAt = new Date(Date.now() - 10_000);
  const resumeAt = new Date(Date.now() - 5_000);
  const service = new SlaService(queue, {
    ticket: { async findMany() { return [
      { id: 'a', firstResponseDueAt: null, firstResponseAt: past, slaDueAt: past },
    ]; } },
    ticketHistory: { async findMany({ where }) {
      return where.field === 'status' ? [{ ticketId: 'a', oldValue: 'PENDING', newValue: 'IN_PROGRESS', createdAt: resumeAt }] : [
        { ticketId: 'a', field: 'sla', newValue: '解决超时', createdAt: receiptAt },
      ];
    } },
  });
  await service.reconcile();
  assert.ok(queue.jobs.has('a-resolve'));
});

test('legacy alert after resume suppresses repeat reconciliation escalation', async () => {
  const queue = queueMock();
  const receiptAt = new Date(Date.now() - 10_000);
  const resumeAt = new Date(Date.now() - 20_000);
  const service = new SlaService(queue, {
    ticket: { async findMany() { return [
      { id: 'a', firstResponseDueAt: null, firstResponseAt: past, slaDueAt: past },
    ]; } },
    ticketHistory: { async findMany({ where }) {
      return where.field === 'status' ? [{ ticketId: 'a', oldValue: 'PENDING', newValue: 'IN_PROGRESS', createdAt: resumeAt }] : [
        { ticketId: 'a', field: 'sla', newValue: '解决超时', createdAt: receiptAt },
      ];
    } },
  });
  await service.reconcile();
  assert.equal(queue.jobs.size, 0);
});

test('legacy receipt still suppresses an unchanged pre-upgrade deadline', async () => {
  const queue = queueMock();
  const service = new SlaService(queue, {
    ticket: { async findMany() { return [
      { id: 'a', firstResponseDueAt: null, firstResponseAt: past, slaDueAt: past },
    ]; } },
    ticketHistory: { async findMany({ where }) {
      return where.field === 'status' ? [] : [
        { ticketId: 'a', field: 'sla', newValue: '解决超时', createdAt: future },
      ];
    } },
  });
  await service.reconcile();
  assert.equal(queue.jobs.size, 0);
});

test('active old job does not delay scheduling a replacement deadline', async () => {
  const queue = queueMock();
  const service = new SlaService(queue, {});
  await service.schedule('a', 'resolve', past);
  queue.jobs.get('a-resolve').getState = async () => 'active';
  await service.schedule('a', 'resolve', future);
  const replacementId = `a-resolve-${future.getTime()}`;
  assert.ok(queue.jobs.has(replacementId), 'new deadline must be scheduled immediately');
  assert.equal(queue.jobs.get(replacementId).data.dueAt, future.toISOString());
  queue.jobs.delete('a-resolve'); // old active job completes and is removed
  await service.schedule('a', 'resolve', future);
  assert.deepEqual([...queue.jobs.keys()], [replacementId], 'scan must not add a second base job');
});

test('pause cancels the replacement while an old job is active', async () => {
  const queue = queueMock();
  const prisma = {
    ticket: {
      async findUnique() { return { firstResponseDueAt: null, slaDueAt: future }; },
      async findMany() { return []; }, // PENDING is outside reconciliation scope
    },
    ticketHistory: { async findMany() { return []; } },
  };
  const service = new SlaService(queue, prisma);
  await service.schedule('a', 'resolve', past);
  queue.jobs.get('a-resolve').getState = async () => 'active';
  await service.schedule('a', 'resolve', future);
  const replacementId = `a-resolve-${future.getTime()}`;
  assert.ok(queue.jobs.has(replacementId));
  await service.cancel('a', 'resolve');
  await service.reconcile();
  assert.equal(queue.jobs.has(replacementId), false);
  assert.ok(queue.jobs.has('a-resolve'), 'active job remains locked and must be state-checked by worker');
});

function processorFixture(overrides = {}) {
  const ticket = {
    id: 'a', ticketNo: 'T-1', title: 'Test', status: 'IN_PROGRESS', priority: 'MEDIUM',
    assigneeId: 'agent', requesterId: 'requester', firstResponseAt: null,
    firstResponseDueAt: past, slaDueAt: past, ...overrides,
  };
  const history = [];
  const notifications = [];
  const tx = {
    async $queryRaw() {},
    ticket: {
      async findUnique() { return ticket; },
      async update({ data }) { Object.assign(ticket, data); },
    },
    ticketHistory: {
      async findFirst({ where, orderBy }) {
        const matches = history.filter((row) => row.field === where.field
          && (where.oldValue === undefined || row.oldValue === where.oldValue)
          && (where.newValue === undefined || (typeof where.newValue === 'object'
            ? where.newValue.in.includes(row.newValue) : row.newValue === where.newValue))
          && (where.OR === undefined || where.OR.some((clause) => Object.entries(clause)
            .every(([field, value]) => row[field] === value)))
          && (where.createdAt === undefined || (
            (where.createdAt.gte === undefined || row.createdAt >= where.createdAt.gte)
            && (where.createdAt.gt === undefined || row.createdAt > where.createdAt.gt)
          )));
        if (orderBy?.createdAt === 'desc') matches.sort((a, b) => b.createdAt - a.createdAt);
        return matches[0] || null;
      },
      async create({ data }) { history.push(data); },
    },
    user: { async findMany() { return [{ id: 'admin' }]; } },
    notification: { async create({ data }) { notifications.push(data); } },
  };
  let tail = Promise.resolve();
  const processor = new SlaProcessor({
    async $transaction(fn) {
      let release;
      const previous = tail;
      tail = new Promise((resolve) => { release = resolve; });
      await previous; // models PostgreSQL's per-ticket row lock
      try { return await fn(tx); } finally { release(); }
    },
  }, { enabled: false });
  return { processor, ticket, history, notifications };
}

test('replayed resolution creates one notification per recipient and one escalation', async () => {
  const { processor, ticket, history, notifications } = processorFixture();
  const job = { data: { ticketId: 'a', kind: 'resolve', dueAt: past.toISOString() } };
  await processor.process(job);
  await processor.process(job);
  assert.equal(ticket.priority, 'HIGH');
  assert.equal(history.filter((entry) => entry.field === 'priority').length, 1);
  assert.equal(history.filter((entry) => entry.field === 'sla_resolve').length, 1);
  assert.equal(notifications.length, 2);
});

test('concurrent workers serialize their effects on the same ticket', async () => {
  const { processor, ticket, history, notifications } = processorFixture();
  const job = { data: { ticketId: 'a', kind: 'resolve', dueAt: past.toISOString() } };
  await Promise.all([processor.process(job), processor.process(job)]);
  assert.equal(ticket.priority, 'HIGH');
  assert.equal(history.filter((entry) => entry.field === 'sla_resolve').length, 1);
  assert.equal(notifications.length, 2);
});

test('paused, terminal, responded, future and superseded deadlines do nothing', async () => {
  for (const override of [
    { status: 'PENDING' }, { status: 'CLOSED' },
    { firstResponseAt: past }, { firstResponseDueAt: future },
  ]) {
    const { processor, history, notifications } = processorFixture(override);
    await processor.process({ data: { ticketId: 'a', kind: 'response', dueAt: past.toISOString() } });
    assert.equal(history.length, 0);
    assert.equal(notifications.length, 0);
  }
  const { processor, history } = processorFixture({ slaDueAt: future });
  await processor.process({ data: { ticketId: 'a', kind: 'resolve', dueAt: past.toISOString() } });
  assert.equal(history.length, 0);
});

test('old-format receipt cannot suppress an overdue resumed deadline', async () => {
  const { processor, history, notifications } = processorFixture();
  const receiptAt = new Date(Date.now() - 10_000);
  history.push({ field: 'sla', newValue: '解决超时', createdAt: receiptAt });
  history.push({ field: 'status', oldValue: 'PENDING', newValue: 'IN_PROGRESS', createdAt: new Date(Date.now() - 5_000) });
  await processor.process({ data: { ticketId: 'a', kind: 'resolve', dueAt: past.toISOString() } });
  assert.equal(notifications.length, 2);
  assert.equal(history.filter((entry) => entry.field === 'sla_resolve').length, 1);
});

test('old-format alert after resume prevents a second priority escalation', async () => {
  const { processor, ticket, history, notifications } = processorFixture();
  history.push({ field: 'status', oldValue: 'PENDING', newValue: 'IN_PROGRESS', createdAt: new Date(Date.now() - 20_000) });
  history.push({ field: 'sla', newValue: '解决超时', createdAt: new Date(Date.now() - 10_000) });
  await processor.process({ data: { ticketId: 'a', kind: 'resolve', dueAt: past.toISOString() } });
  assert.equal(ticket.priority, 'MEDIUM');
  assert.equal(notifications.length, 0);
  assert.equal(history.filter((entry) => entry.field === 'sla_resolve').length, 0);
});

test('latest legacy alert wins when a ticket has multiple legacy alerts', async () => {
  const { processor, history, notifications } = processorFixture();
  history.push({ field: 'sla', newValue: '解决超时', createdAt: new Date(Date.now() - 40_000) });
  history.push({ field: 'status', oldValue: 'PENDING', newValue: 'IN_PROGRESS', createdAt: new Date(Date.now() - 30_000) });
  history.push({ field: 'sla', newValue: '解决超时', createdAt: new Date(Date.now() - 10_000) });
  await processor.process({ data: { ticketId: 'a', kind: 'resolve', dueAt: past.toISOString() } });
  assert.equal(notifications.length, 0);
  assert.equal(history.filter((entry) => entry.field === 'sla_resolve').length, 0);
});

test('old-format receipt suppresses unchanged deadline without pause or reopen', async () => {
  const { processor, history, notifications } = processorFixture();
  history.push({ field: 'sla', newValue: '解决超时', createdAt: future });
  await processor.process({ data: { ticketId: 'a', kind: 'resolve', dueAt: past.toISOString() } });
  assert.equal(notifications.length, 0);
  assert.equal(history.filter((entry) => entry.field === 'sla_resolve').length, 0);
});
