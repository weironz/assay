import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentsService } from '../src/attachments/attachments.service';

function fixture(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const rec = { id: 'att1', uploaderId: 'u1', ticketId: 't1', messageId: 'm1', objectKey: 'key1', fileName: 'file.docx', ...overrides };
  const tx: any = {
    ticketAttachment: {
      findUnique: async () => rec,
      deleteMany: async () => { events.push('delete'); return { count: 1 }; },
    },
    ticket: { findUnique: async () => ({ requesterId: 'u1', assigneeId: null, participants: [] }) },
    ticketMessage: { findFirst: async () => null },
    attachmentDeletionTask: { createMany: async () => { events.push('queue'); return { count: 1 }; } },
    ticketHistory: { create: async () => { events.push('history'); return {}; } },
  };
  const db: any = { $transaction: async (fn: any, options: any) => {
    assert.equal(options.isolationLevel, 'Serializable');
    const result = await fn(tx); events.push('commit'); return result;
  } };
  const service = new AttachmentsService(db, {} as any);
  service.processPendingDeletions = async () => { events.push('drain'); return { deleted: 1, retrying: 0 }; };
  const user: any = { id: 'u1', roles: ['requester'], permissions: ['ticket:read', 'ticket:create', 'ticket:comment'] };
  return { service, user, tx, events };
}

test('owner deletes an attachment and queues object deletion atomically', async () => {
  const { service, user, events } = fixture();
  assert.deepEqual(await service.remove(user, 'att1'), { ok: true });
  assert.deepEqual(events, ['delete', 'queue', 'history', 'commit', 'drain']);
});

test('another user cannot delete an attachment', async () => {
  const { service, user, events } = fixture({ uploaderId: 'someone-else' });
  await assert.rejects(service.remove(user, 'att1'), { status: 403 });
  assert.deepEqual(events, []);
});

test('message-referenced attachment cannot be deleted', async () => {
  const { service, user, tx, events } = fixture();
  tx.ticketMessage.findFirst = async () => ({ id: 'm1' });
  await assert.rejects(service.remove(user, 'att1'), { status: 400 });
  assert.deepEqual(events, []);
});

test('draft deletion requires ticket creation permission', async () => {
  const { service, user, events } = fixture({ ticketId: null, messageId: null });
  user.permissions = ['ticket:read'];
  await assert.rejects(service.remove(user, 'att1'), { status: 403 });
  assert.deepEqual(events, []);
});

test('a concurrent change stops deletion before enqueuing', async () => {
  const { service, user, tx, events } = fixture();
  tx.ticketAttachment.deleteMany = async () => ({ count: 0 });
  await assert.rejects(service.remove(user, 'att1'), { status: 400 });
  assert.deepEqual(events, []);
});
