const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { PrismaClient } = require('@prisma/client');
const { AttachmentsService } = require('../dist/attachments/attachments.service');
const { S3Storage } = require('../dist/storage/s3.storage');
const { TicketMessaging } = require('../dist/tickets/ticket-messaging');
const { processObjectDeletions } = require('../dist/attachments/deletion-queue');

const url = process.env.TICKET_LIFECYCLE_TEST_DATABASE_URL;
const endpoint = process.env.INLINE_IMAGE_TEST_S3_ENDPOINT;
const src = id => `/api/attachments/${id}/download`;
const img = id => `<img src="${src(id)}" />`;

test('removing inline images deletes unreferenced objects, preserves other references and standalone files, and retries storage failure', { skip: !url }, async () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const prefix = `inline-test-${randomUUID()}`;
  const objectKeys = [];
  const files = new Map();
  const storage = endpoint ? new S3Storage('inline-image-regression', endpoint, 'us-east-1', 'ciaccesskey', 'cisecretkey', true) : {
    put: async ({ key, body }) => { files.set(key, body); },
    get: async key => { if (!files.has(key)) throw new Error('NoSuchKey'); return files.get(key); },
    delete: async key => { files.delete(key); },
  };
  const service = new AttachmentsService(db, storage);
  // Let the test decide when each queued attempt runs.
  service.processPendingDeletions = async () => ({ deleted: 0, retrying: 0 });
  const messaging = new TicketMessaging(db, { notify: async () => {} }, {}, service);
  let owner;
  try {
    if (endpoint) await storage.ensureBucket();
    owner = await db.user.create({ data: { name: 'Inline regression', email: `${prefix}@example.test` } });
    const user = { id: owner.id, roles: ['requester'], permissions: ['ticket:read', 'ticket:comment'] };
    const createTicket = async suffix => db.ticket.create({ data: {
      title: 'Inline regression', ticketNo: `${prefix}-${suffix}`, requesterId: user.id,
    } });
    const first = await createTicket('first');
    const second = await createTicket('second');
    const original = await messaging.addMessage(user, first.id, { body: '<p>Initial report</p>' });
    const upload = async (name, isInline, messageId = null) => {
      const objectKey = `${prefix}/${name}.png`;
      objectKeys.push(objectKey);
      await storage.put({ key: objectKey, body: Buffer.from(name), contentType: 'image/png' });
      return db.ticketAttachment.create({ data: {
        ticketId: first.id, messageId, fileName: `${name}.png`, objectKey,
        fileSize: name.length, mime: 'image/png', uploaderId: user.id, isInline,
      } });
    };
    const inline = await upload('inline', true);
    const standalone = await upload('standalone', false);
    const legacy = await upload('legacy', null, original.id);
    const neverInserted = await upload('never-inserted', true);
    await messaging.updateMessage(user, first.id, original.id, { body: img(inline.id) + img(standalone.id) + img(legacy.id) });
    const sameTicketRef = await messaging.addMessage(user, first.id, { body: `See <a href="${src(inline.id)}">image</a>` });
    const crossTicketRef = await messaging.addMessage(user, second.id, { body: img(inline.id) });
    await messaging.updateMessage(user, first.id, original.id, { body: '<p>Removed images</p>' });
    const tasks = () => db.attachmentDeletionTask.findMany({ where: { objectKey: { in: objectKeys } } });
    assert.deepEqual((await tasks()).map(row => [row.objectKey, row.reason]), [[legacy.objectKey, 'INLINE_IMAGE_REMOVED']]);
    assert.equal(await db.ticketAttachment.findUnique({ where: { id: legacy.id } }), null);
    await assert.rejects(service.remove(user, inline.id), { status: 400 });
    await messaging.updateMessage(user, first.id, sameTicketRef.id, { body: '<p>See other ticket</p>' });
    await assert.rejects(service.remove(user, inline.id), { status: 400 });

    // The last reference can be removed in a different ticket.
    await messaging.updateMessage(user, second.id, crossTicketRef.id, { body: '<p></p>' });
    assert.equal(await db.ticketAttachment.findUnique({ where: { id: inline.id } }), null);
    await assert.rejects(messaging.addMessage(user, first.id, { body: img(inline.id) }), { status: 409 });
    assert.ok(await db.ticketAttachment.findUnique({ where: { id: standalone.id } }));
    assert.ok(await db.ticketAttachment.findUnique({ where: { id: neverInserted.id } }));
    assert.equal((await storage.get(standalone.objectKey)).toString(), 'standalone');

    const queue = { attachmentDeletionTask: {
      findMany: ({ where, ...rest }) => db.attachmentDeletionTask.findMany({ ...rest, where: { ...where, objectKey: { in: objectKeys } } }),
      updateMany: args => db.attachmentDeletionTask.updateMany(args),
      update: args => db.attachmentDeletionTask.update(args),
      deleteMany: args => db.attachmentDeletionTask.deleteMany(args),
    } };
    const quiet = { error() {} };
    const start = new Date();
    const failed = await processObjectDeletions(queue, { delete: async key => {
      if (key === inline.objectKey) throw new Error('temporary S3 failure');
      await storage.delete(key);
    } }, quiet, start);
    assert.deepEqual(failed, { deleted: 1, retrying: 1 });
    assert.equal((await storage.get(inline.objectKey)).toString(), 'inline');
    assert.deepEqual(await processObjectDeletions(queue, storage, quiet, new Date(start.getTime() + 6 * 60_000)), { deleted: 1, retrying: 0 });
    assert.deepEqual(await tasks(), []);
    for (const row of [legacy, inline]) await assert.rejects(storage.get(row.objectKey));

    // CLI/MCP and REST all call this same explicit delete path.
    await service.remove(user, standalone.id);
    assert.equal((await tasks())[0].reason, 'ATTACHMENT_DELETED');
    assert.deepEqual(await processObjectDeletions(queue, storage, quiet), { deleted: 1, retrying: 0 });
    await assert.rejects(storage.get(standalone.objectKey));
    assert.equal((await storage.get(neverInserted.objectKey)).toString(), 'never-inserted');
  } finally {
    try {
      if (owner) {
        await db.ticket.deleteMany({ where: { requesterId: owner.id } });
        await db.user.delete({ where: { id: owner.id } });
      }
      await db.attachmentDeletionTask.deleteMany({ where: { objectKey: { in: objectKeys } } });
      for (const key of objectKeys) await storage.delete(key);
    } finally { await db.$disconnect(); }
  }
});
