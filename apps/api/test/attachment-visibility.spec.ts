import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentsService } from '../src/attachments/attachments.service';
import { loadAttachmentReferences } from '../src/attachments/visibility';
import { TicketSharesService } from '../src/ticket-shares/ticket-shares.service';
import { TicketsService } from '../src/tickets/tickets.service';

const TOKEN = `shr_${'a'.repeat(43)}`;

const ticketAccess = {
  requesterId: 'requester',
  assigneeId: null,
  participants: [],
};

const requester = {
  id: 'requester',
  roles: ['requester'],
  permissions: ['ticket:read'],
} as any;

const storage = () => ({ getStream: async () => ({}) }) as any;

test('reference sets keep internal and public ids separate', async () => {
  const sets = await loadAttachmentReferences(
    {
      ticketMessage: {
        findMany: async () => [
          { isInternal: false, body: '<img src="/api/attachments/public/download">' },
          {
            isInternal: true,
            body: '<img src="/api/attachments/shared/download"><img src="/api/attachments/internal-only/download">',
          },
        ],
      },
    } as any,
    'ticket-1',
  );
  assert.deepEqual([...sets.publicIds].sort(), ['public']);
  assert.deepEqual([...sets.internalIds].sort(), ['internal-only', 'shared']);
});

test('unbound attachment referenced by both an internal note and a public reply stays internal', async () => {
  const service = new AttachmentsService(
    {
      ticket: { findUnique: async () => ticketAccess },
      ticketAttachment: {
        findUnique: async () => ({
          id: 'att-1',
          ticketId: 'ticket-1',
          messageId: null,
          objectKey: 'ticket-1/att-1',
          uploaderId: 'staff',
          fileName: 'internal.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findMany: async () => [
          { isInternal: true, body: '<img src="/api/attachments/att-1/download">' },
          { isInternal: false, body: '<img src="/api/attachments/att-1/download">' },
        ],
      },
    } as any,
    storage(),
  );

  await assert.rejects(service.getForDownload(requester, 'att-1'), { status: 403 });
});

test('attachment bound to an internal note is denied even when a public reply references it', async () => {
  const service = new AttachmentsService(
    {
      ticket: { findUnique: async () => ticketAccess },
      ticketAttachment: {
        findUnique: async () => ({
          id: 'att-2',
          ticketId: 'ticket-1',
          messageId: 'message-internal',
          objectKey: 'ticket-1/att-2',
          uploaderId: 'staff',
          fileName: 'leaked.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findFirst: async () => ({ isInternal: true }),
        findMany: async () => [
          { isInternal: false, body: '<img src="/api/attachments/att-2/download">' },
        ],
      },
    } as any,
    storage(),
  );

  await assert.rejects(service.getForDownload(requester, 'att-2'), { status: 403 });
});

test('attachment bound to a public message follows the binding, not internal note references', async () => {
  const service = new AttachmentsService(
    {
      ticket: { findUnique: async () => ticketAccess },
      ticketAttachment: {
        findUnique: async () => ({
          id: 'att-3',
          ticketId: 'ticket-1',
          messageId: 'message-public',
          objectKey: 'ticket-1/att-3',
          uploaderId: 'staff',
          fileName: 'public.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findFirst: async () => ({ isInternal: false }),
        findMany: async () => {
          throw new Error('bound attachments must not fall back to body references');
        },
      },
    } as any,
    storage(),
  );

  const { rec } = await service.getForDownload(requester, 'att-3');
  assert.equal(rec.id, 'att-3');
});

test('share endpoint rejects an internal-note attachment referenced by a public reply', async () => {
  const service = new TicketSharesService(
    {
      ticketShare: {
        findUnique: async () => ({
          id: 'share-1',
          ticketId: 'ticket-1',
          expiresAt: null,
          revokedAt: null,
        }),
      },
      ticketAttachment: {
        findFirst: async () => ({
          messageId: 'message-internal',
          objectKey: 'ticket-1/att-2',
          fileName: 'leaked.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findFirst: async () => ({ isInternal: true }),
        findMany: async () => [
          { isInternal: false, body: '<img src="/api/attachments/att-2/download">' },
        ],
      },
    } as any,
    storage(),
  );

  await assert.rejects(service.publicInlineAttachment(TOKEN, 'att-2'), { status: 404 });
});

test('share endpoint hides an unbound image that any internal note references', async () => {
  const service = new TicketSharesService(
    {
      ticketShare: {
        findUnique: async () => ({
          id: 'share-1',
          ticketId: 'ticket-1',
          expiresAt: null,
          revokedAt: null,
        }),
      },
      ticketAttachment: {
        findFirst: async () => ({
          messageId: null,
          objectKey: 'ticket-1/att-1',
          fileName: 'internal.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findMany: async () => [
          { isInternal: true, body: '<img src="/api/attachments/att-1/download">' },
          { isInternal: false, body: '<img src="/api/attachments/att-1/download">' },
        ],
      },
    } as any,
    storage(),
  );

  await assert.rejects(service.publicInlineAttachment(TOKEN, 'att-1'), { status: 404 });
});

test('share endpoint still serves an unbound image referenced only by a public reply', async () => {
  const service = new TicketSharesService(
    {
      ticketShare: {
        findUnique: async () => ({
          id: 'share-1',
          ticketId: 'ticket-1',
          expiresAt: null,
          revokedAt: null,
        }),
      },
      ticketAttachment: {
        findFirst: async () => ({
          messageId: null,
          objectKey: 'ticket-1/att-public',
          fileName: 'public.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findMany: async () => [
          { isInternal: false, body: '<img src="/api/attachments/att-public/download">' },
        ],
      },
    } as any,
    storage(),
  );

  const { attachment } = await service.publicInlineAttachment(TOKEN, 'att-public');
  assert.equal(attachment.fileName, 'public.png');
});

test('posting a message binds referenced attachments inside the same transaction', async () => {
  const events: string[] = [];
  let inTransaction = false;
  const tx = {
    ticketMessage: {
      create: async () => ({
        id: 'message-1',
        body: '<img src="/api/attachments/att-1/download">',
        author: { id: 'requester' },
        mentions: [],
      }),
    },
    ticketAttachment: {
      updateMany: async (args: any) => {
        assert.equal(inTransaction, true);
        assert.deepEqual(args.data, { messageId: 'message-1' });
        events.push('bind');
        return { count: 1 };
      },
    },
  };
  const service = new TicketsService(
    {
      ticket: {
        findUnique: async () => ({
          id: 'ticket-1',
          ticketNo: 'WO-1',
          title: 'fixture',
          requesterId: 'requester',
          assigneeId: null,
          participants: [],
          firstResponseAt: new Date(),
        }),
      },
      ticketHistory: { create: async () => ({}) },
      // 如果绑定跑到事务外，这个 mock 会直接报错。
      ticketAttachment: {
        updateMany: async () => {
          throw new Error('attachment binding escaped the message transaction');
        },
      },
      $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
        events.push('begin');
        inTransaction = true;
        try {
          return await work(tx);
        } finally {
          inTransaction = false;
          events.push('commit');
        }
      },
    } as any,
    {} as any,
    { notify: async () => ({}) } as any,
    { cancel: async () => ({}) } as any,
  );

  const message = await service.addMessage(requester, 'ticket-1', {
    body: '<p>see <img src="/api/attachments/att-1/download"></p>',
  } as any);
  assert.equal((message as any).id, 'message-1');
  assert.deepEqual(events, ['begin', 'bind', 'commit']);
});
