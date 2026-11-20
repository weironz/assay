const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');
const { TicketEditor } = require('../dist/tickets/ticket-editor');
const { TicketLifecycle } = require('../dist/tickets/ticket-lifecycle');
const { TicketDeletion } = require('../dist/tickets/ticket-deletion');
const { TicketMessaging } = require('../dist/tickets/ticket-messaging');
const { WorkflowService } = require('../dist/tickets/workflow.service');
const { allocateTicketNo } = require('../dist/tickets/core');
const { AttachmentsService } = require('../dist/attachments/attachments.service');
const { MAX_ATTACHMENTS_PER_TICKET, MAX_DAILY_UPLOADS } = require('../dist/attachments/limits');
const { enqueueObjectDeletions } = require('../dist/attachments/deletion-queue');

const url = process.env.TICKET_LIFECYCLE_TEST_DATABASE_URL;

async function withUser(work) {
  const db = new PrismaClient({ datasourceUrl: url });
  const tag = `write-safety-${randomUUID()}`;
  let user;
  try {
    user = await db.user.create({ data: { name: tag, email: `${tag}@example.test` } });
    await work(db, { ...user, roles: ['requester'], permissions: ['ticket:read', 'ticket:create'] }, tag);
  } finally {
    try {
      if (user) {
        await db.ticketCreationRequest.deleteMany({ where: { requesterId: user.id } });
        await db.ticket.deleteMany({ where: { requesterId: user.id } });
        await db.ticketAttachment.deleteMany({ where: { uploaderId: user.id } });
        await db.ticketUploadUsage.deleteMany({ where: { uploaderId: user.id } });
        await db.user.delete({ where: { id: user.id } });
      }
      await db.attachmentDeletionTask.deleteMany({ where: { objectKey: { startsWith: tag + '/' } } });
    } finally { await db.$disconnect(); }
  }
}

const image = (id, suffix = '') => `<img src="https://example.test/api/attachments/${id}/download${suffix}" />`;
const ticketDraft = (title, body = '<p>Details</p>') => ({ title, body });

test('daily numbering is numeric, survives deletion, and allocates concurrent values exactly once', { skip: !url }, async () => {
  await withUser(async (db, user) => {
    const day = '20990411';
    const old = await db.ticket.create({
      data: { ticketNo: `WO-${day}-9999`, title: 'Older API fixture', requesterId: user.id },
    });
    await db.ticket.delete({ where: { id: old.id } });
    try {
      const date = new Date('2099-04-11T12:00:00Z');
      const numbers = await Promise.all(Array.from({ length: 6 }, () => db.$transaction(tx => allocateTicketNo(tx, date))));
      assert.deepEqual(numbers.sort(), Array.from({ length: 6 }, (_, i) => `WO-${day}-${10000 + i}`));
    } finally {
      await db.ticketNumberCounter.deleteMany({ where: { day } });
    }
  });
});

test('uploads racing for the final daily slot cannot exceed the limit and deleting it does not refund quota', { skip: !url, timeout: 15000 }, async () => {
  await withUser(async (db, user, tag) => {
    await db.ticketUploadUsage.createMany({
      data: Array.from({ length: MAX_DAILY_UPLOADS - 1 }, (_, i) => ({
        id: `${tag}-${i}`, uploaderId: user.id, fileSize: 1, createdAt: new Date(),
      })),
    });
    const directory = await mkdtemp(join(tmpdir(), 'assay-quota-'));
    const file = async name => {
      const path = join(directory, name);
      await writeFile(path, 'x');
      return { path, originalname: name, size: 1, mimetype: 'text/plain' };
    };
    const objects = new Set();
    let streams = 0;
    let open;
    const barrier = new Promise(resolve => { open = resolve; });
    const store = {
      putStream: async ({ key, body }) => {
        for await (const chunk of body) assert.equal(chunk.length, 1);
        objects.add(key);
        if (++streams === 2) open();
        await barrier;
      },
      delete: async key => objects.delete(key),
    };
    try {
      const service = new AttachmentsService(db, store);
      const files = await Promise.all([file('one.txt'), file('two.txt')]);
      const results = await Promise.allSettled(files.map(entry => service.uploadDraft(user, entry)));
      const succeeded = results.filter(result => result.status === 'fulfilled');
      assert.equal(succeeded.length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.getStatus(), 400);
      assert.equal(objects.size, 1);
      await db.ticketAttachment.delete({ where: { id: succeeded[0].value.id } });
      await assert.rejects(service.uploadDraft(user, await file('retry.txt')), { status: 400 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('binding a draft in a reply cannot exceed the per-ticket cap', { skip: !url }, async () => {
  await withUser(async (db, user, tag) => {
    const ticket = await db.ticket.create({ data: { ticketNo: tag, title: tag, requesterId: user.id } });
    const attachment = index => ({ fileName: 'fixture.png', objectKey: `${tag}/${index}`, fileSize: 1,
      mime: 'image/png', uploaderId: user.id, isInline: true });
    await db.ticketAttachment.createMany({
      data: Array.from({ length: MAX_ATTACHMENTS_PER_TICKET }, (_, i) => ({ ...attachment(i), ticketId: ticket.id })),
    });
    const draft = await db.ticketAttachment.create({ data: attachment('draft') });
    const messaging = new TicketMessaging(db, {}, {}, {});
    await assert.rejects(messaging.addMessage(user, ticket.id, { body: image(draft.id) }), { status: 400 });
    assert.equal(await db.ticketMessage.count({ where: { ticketId: ticket.id } }), 0);
    assert.equal((await db.ticketAttachment.findUniqueOrThrow({ where: { id: draft.id } })).ticketId, null);
  });
});

test('SLA failure and concurrent retries return one committed ticket; discarded draft objects are queued', { skip: !url }, async () => {
  await withUser(async (db, user, tag) => {
    const editor = new TicketEditor(db, { schedule: async () => { throw new Error('fixture queue unavailable'); } });
    const createDraft = (kind, isInline) => db.ticketAttachment.create({ data: {
      fileName: kind + '.png', objectKey: tag + '/' + kind, fileSize: 12, mime: 'image/png',
      uploaderId: user.id, isInline,
    } });
    const [kept, discarded, standalone, historical] = await Promise.all([
      createDraft('kept', true), createDraft('discarded', true), createDraft('standalone', false),
      createDraft('historical', true),
    ]);
    // Simulate a historical body written by an older API without registering the reference.
    const older = await db.ticket.create({ data: {
      ticketNo: tag, title: tag, requesterId: user.id,
      messages: { create: { authorId: user.id, body: image(historical.id, '?width=10') } },
    } });
    const idempotencyKey = randomUUID();
    const dto = {
      ...ticketDraft(`${tag} retry`, '<p>Kept image</p>' + image(kept.id)),
      idempotencyKey, attachmentIds: [discarded.id, standalone.id, historical.id],
    };
    const [first, second] = await Promise.all([editor.create(user, dto), editor.create(user, dto)]);
    assert.equal(first, second);
    assert.equal(await db.ticket.count({ where: { requesterId: user.id, title: dto.title } }), 1);
    assert.equal(await db.ticketHistory.count({ where: { ticketId: first, action: 'CREATE' } }), 1);
    const ticket = await db.ticket.findUniqueOrThrow({ where: { id: first } });
    assert.ok(ticket.firstResponseDueAt > ticket.createdAt && ticket.slaDueAt > ticket.firstResponseDueAt);
    for (const id of [kept.id, standalone.id]) {
      assert.equal((await db.ticketAttachment.findUniqueOrThrow({ where: { id } })).ticketId, first);
    }
    assert.equal(await db.ticketAttachment.findUnique({ where: { id: discarded.id } }), null);
    assert.equal((await db.ticketAttachment.findUniqueOrThrow({ where: { id: historical.id } })).ticketId, null);
    const queued = await db.attachmentDeletionTask.findMany({ where: { objectKey: { startsWith: tag + '/' } } });
    assert.deepEqual(queued.map(({ objectKey, reason }) => [objectKey, reason]), [[discarded.objectKey, 'INLINE_DRAFT_DISCARDED']]);
    assert.equal(await db.ticketAttachmentReference.count({ where: { message: { ticketId: older.id }, attachmentId: historical.id } }), 1);
    await assert.rejects(editor.create(user, { ...dto, title: 'different request' }), { status: 409 });
    await db.ticket.delete({ where: { id: first } });
    await assert.rejects(editor.create(user, dto), { status: 409 });
  });
});

test('whole-ticket deletion waits for prior uploads and blocks a new upload until cascade completes', { skip: !url }, async () => {
  await withUser(async (db, user, tag) => {
    const ticket = await db.ticket.create({ data: { ticketNo: tag, title: tag, requesterId: user.id } });
    const attachment = name => ({ ticketId: ticket.id, fileName: name + '.png', objectKey: tag + '/' + name,
      fileSize: 12, mime: 'image/png', uploaderId: user.id });
    const editor = new TicketDeletion(db, { cancel: async () => {} }, {
      queueObjectDeletions: async (tx, keys, reason) => {
        foundKeys(keys);
        await releaseDelete.promise;
        return enqueueObjectDeletions(tx, keys, reason);
      },
      processPendingDeletions: async () => {},
    });
    const gate = () => {
      let open;
      const promise = new Promise(resolve => { open = resolve; });
      return { promise, open };
    };
    const releaseDelete = gate();
    let foundKeys;
    const scanned = new Promise(resolve => { foundKeys = resolve; });
    const uploaded = gate(), releaseUpload = gate();
    const early = db.$transaction(async tx => {
      await tx.ticketAttachment.create({ data: attachment('early') });
      uploaded.open();
      await releaseUpload.promise;
    });
    await Promise.race([uploaded.promise, early]);
    const deleting = editor.remove(user, ticket.id);
    try {
      // Give deletion a chance to enter the database while the upload is uncommitted.
      await new Promise(resolve => setTimeout(resolve, 40));
      releaseUpload.open();
      await early;
      assert.deepEqual(await Promise.race([scanned, deleting]), [tag + '/early']);
      const late = assert.rejects(db.ticketAttachment.create({ data: attachment('late') }), { code: 'P2003' });
      releaseDelete.open();
      await Promise.all([late, deleting]);
      const pending = await db.attachmentDeletionTask.findMany({ where: { objectKey: { startsWith: tag + '/' } } });
      assert.deepEqual(pending.map(row => row.objectKey), [tag + '/early']);
    } finally {
      releaseUpload.open();
      releaseDelete.open();
      await Promise.allSettled([early, deleting]);
    }
  });
});

test('assignment cannot overwrite a concurrent cancellation and cannot commit without its audit', { skip: !url }, async () => {
  await withUser(async (db, user, tag) => {
    const make = suffix => db.ticket.create({ data: { ticketNo: tag + suffix, title: tag, requesterId: user.id } });
    const cancelled = await make('-cancel');
    const audited = await make('-audit');
    let notificationCount = 0;
    const notify = { notify: async () => { notificationCount++; } };
    const raced = new TicketLifecycle({
      ticket: db.ticket,
      user: { findUnique: async () => {
        await db.ticket.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });
        return user;
      } },
      $transaction: db.$transaction.bind(db),
    }, {}, notify, {});
    await assert.rejects(raced.assign(user, cancelled.id, { assigneeId: user.id }), { status: 409 });
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: cancelled.id } })).status, 'CANCELLED');
    const auditFailure = new TicketLifecycle({
      ticket: db.ticket, user: db.user,
      $transaction: fn => db.$transaction(tx => fn({
        ticket: tx.ticket,
        ticketHistory: { create: async () => { throw new Error('audit unavailable'); } },
      })),
    }, {}, notify, {});
    await assert.rejects(auditFailure.assign(user, audited.id, { assigneeId: user.id }), /audit unavailable/);
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: audited.id } })).status, 'NEW');
    assert.equal(notificationCount, 0);
  });
});

test('committed holds and replies succeed through an SLA outage and record first response once', { skip: !url }, async () => {
  await withUser(async (db, requester, tag) => {
    const staff = await db.user.create({ data: { name: tag, email: `staff-${tag}@example.test` } });
    const actor = { ...staff, roles: ['handler'], permissions: ['ticket:read', 'ticket:transition', 'ticket:comment'] };
    const ticket = await db.ticket.create({ data: {
      ticketNo: tag, title: tag, requesterId: requester.id, assigneeId: staff.id, status: 'IN_PROGRESS',
    } });
    const cancelled = [];
    const sla = { cancel: async (id, kind) => { cancelled.push(kind); throw new Error('fixture Redis unavailable'); } };
    const notifications = { notify: async () => { throw new Error('fixture notification unavailable'); } };
    try {
      const failure = new TicketLifecycle({
        ticket: db.ticket,
        $transaction: work => db.$transaction(tx => work({
          ticket: tx.ticket,
          ticketHistory: { create: async () => { throw new Error('fixture audit unavailable'); } },
        })),
      }, new WorkflowService(), notifications, sla);
      await assert.rejects(failure.transition(actor, ticket.id, 'hold'), /fixture audit unavailable/);
      assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status, 'IN_PROGRESS');
      assert.deepEqual(cancelled, []);

      const lifecycle = new TicketLifecycle(db, new WorkflowService(), notifications, sla);
      await lifecycle.transition(actor, ticket.id, 'hold');
      const messaging = new TicketMessaging(db, notifications, sla, {});
      const replies = await Promise.all([
        messaging.addMessage(actor, ticket.id, { body: '<p>First concurrent reply</p>' }),
        messaging.addMessage(actor, ticket.id, { body: '<p>Second concurrent reply</p>' }),
      ]);
      const updated = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      assert.equal(updated.status, 'PENDING');
      assert.ok(replies.some(reply => +reply.createdAt === +updated.firstResponseAt));
      assert.deepEqual(cancelled, [undefined, 'response']);
      assert.equal(await db.ticketHistory.count({ where: { ticketId: ticket.id } }), 3);
    } finally {
      await db.ticket.delete({ where: { id: ticket.id } });
      await db.user.delete({ where: { id: staff.id } });
    }
  });
});
