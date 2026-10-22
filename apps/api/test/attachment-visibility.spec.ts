import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentsService } from '../src/attachments/attachments.service';
import {
  isReferencedByPublicMessage,
  referencedAttachmentIds,
  rewriteAttachmentUrls,
} from '../src/attachments/visibility';
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

test('URL matching and rewriting cover absolute, /api, relative and query-string forms', () => {
  const body =
    '<img src="https://assay.internal/api/attachments/abs1/download">' +
    '<img src="/api/attachments/api2/download">' +
    '<img src="/attachments/rel3/download">' +
    '<img src="/api/attachments/qry4/download?w=100">';
  assert.deepEqual(
    [...referencedAttachmentIds(body)].sort(),
    ['abs1', 'api2', 'qry4', 'rel3'],
  );
  const rewritten = rewriteAttachmentUrls(body, (id) => `/shared/${id}`);
  assert.equal(
    rewritten,
    '<img src="/shared/abs1">' +
      '<img src="/shared/api2">' +
      '<img src="/shared/rel3">' +
      '<img src="/shared/qry4?w=100">',
  );
});

test('share page rewrites relative attachment links instead of 404ing them', async () => {
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
      ticket: {
        findUnique: async () => ({
          ticketNo: 'WO-1',
          title: 'fixture',
          status: 'OPEN',
          priority: 'MEDIUM',
          createdAt: new Date(),
          updatedAt: new Date(),
          type: null,
          category: null,
          datacenter: null,
          cluster: null,
          serialNumber: null,
          messages: [
            {
              id: 'message-1',
              body: '<img src="/attachments/att-rel/download">',
              createdAt: new Date(),
              author: { name: 'requester' },
            },
          ],
        }),
      },
    } as any,
    storage(),
  );

  const page: any = await service.publicTicket(TOKEN);
  assert.equal(
    page.messages[0].body,
    `<img src="/api/shared-tickets/${encodeURIComponent(TOKEN)}/attachments/att-rel">`,
  );
});

test('public reference check only looks at public messages', async () => {
  let query: any;
  const found = await isReferencedByPublicMessage(
    {
      ticketMessage: {
        findFirst: async (args: any) => {
          query = args;
          return null;
        },
      },
    } as any,
    'ticket-1',
    'att-1',
  );
  assert.equal(found, false);
  assert.deepEqual(query.where, {
    ticketId: 'ticket-1',
    isInternal: false,
    body: { contains: '/attachments/att-1/download' },
  });
});

test('public reference check reports a match from the public body', async () => {
  const found = await isReferencedByPublicMessage(
    { ticketMessage: { findFirst: async () => ({ id: 'message-1' }) } } as any,
    'ticket-1',
    'att-1',
  );
  assert.equal(found, true);
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

test('share endpoint rejects an unbound image even when a public reply references it', async () => {
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
        // 历史数据已由迁移回填；这里模拟查询条件被绕过、仍返回未绑定记录，
        // service 必须自己再拒绝。
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

  await assert.rejects(service.publicInlineAttachment(TOKEN, 'att-public'), { status: 404 });
});

test('share endpoint serves a public-bound image referenced by a public reply', async () => {
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
          messageId: 'message-public',
          objectKey: 'ticket-1/att-bound',
          fileName: 'bound.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findFirst: async () => ({ isInternal: false }),
        findMany: async () => [
          { isInternal: false, body: '<img src="/api/attachments/att-bound/download">' },
        ],
      },
    } as any,
    storage(),
  );

  const { attachment } = await service.publicInlineAttachment(TOKEN, 'att-bound');
  assert.equal(attachment.fileName, 'bound.png');
});

test('requester cannot download an unbound image merely because a public reply references it', async () => {
  const service = new AttachmentsService(
    {
      ticket: { findUnique: async () => ticketAccess },
      ticketAttachment: {
        findUnique: async () => ({
          id: 'att-unbound',
          ticketId: 'ticket-1',
          messageId: null,
          objectKey: 'ticket-1/att-unbound',
          uploaderId: 'staff',
          fileName: 'draft.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: {
        findMany: async () => [
          { isInternal: false, body: '<img src="/api/attachments/att-unbound/download">' },
        ],
      },
    } as any,
    storage(),
  );

  await assert.rejects(service.getForDownload(requester, 'att-unbound'), { status: 403 });
});

test('message edit scopes authorization into the query and does not read an internal note body', async () => {
  const queries: any[] = [];
  let updates = 0;
  const ticket = {
    id: 'ticket-1',
    requesterId: 'requester',
    assigneeId: null,
    participants: [],
  };
  const prisma: any = {
    ticket: { findUnique: async () => ticket },
    ticketMessage: {
      findFirst: async (args: any) => {
        queries.push(args);
        // 第一个查询带授权条件（作者 + 非内部），返回空；第二个只取元数据用于区分 403。
        return queries.length === 1 ? null : { authorId: 'staff', isInternal: true };
      },
      update: async () => {
        updates += 1;
        throw new Error('unauthorized edit must not reach update');
      },
    },
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) => work(prisma);

  const service = new TicketsService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  await assert.rejects(
    service.updateMessage(requester, 'ticket-1', 'message-1', { body: 'edited' } as any),
    { status: 403 },
  );
  assert.equal(updates, 0);
  assert.deepEqual(queries[0].where, {
    id: 'message-1',
    ticketId: 'ticket-1',
    authorId: 'requester',
    isInternal: false,
  });
  // 授权查询只取 id，不把正文读出来再判断。
  assert.deepEqual(queries[0].select, { id: true });
});

test('message author can edit their own public message inside the transaction', async () => {
  const events: string[] = [];
  let authorization: any;
  const ticket = {
    id: 'ticket-1',
    requesterId: 'requester',
    assigneeId: null,
    participants: [],
  };
  const prisma: any = {
    ticket: { findUnique: async () => ticket },
    ticketHistory: { create: async () => ({}) },
    ticketMessage: {
      findFirst: async (args: any) => {
        authorization = args;
        return { id: 'message-1' };
      },
      update: async (args: any) => {
        events.push(`update:${args.where.id}`);
        return {
          id: 'message-1',
          body: '<p>edited</p><img src="/api/attachments/att-1/download">',
          author: { id: 'requester' },
        };
      },
    },
    ticketAttachment: {
      updateMany: async (args: any) => {
        if (args.data.messageId) events.push('link-attachments');
        return { count: 0 };
      },
    },
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) => {
    events.push('begin');
    try {
      return await work(prisma);
    } finally {
      events.push('commit');
    }
  };

  const service = new TicketsService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const updated: any = await service.updateMessage(
    requester,
    'ticket-1',
    'message-1',
    { body: '<p>edited</p>' } as any,
  );
  assert.equal(updated.id, 'message-1');
  assert.deepEqual(authorization.where, {
    id: 'message-1',
    ticketId: 'ticket-1',
    authorId: 'requester',
    isInternal: false,
  });
  assert.deepEqual(events, ['begin', 'update:message-1', 'link-attachments', 'commit']);
});

test('creating a ticket binds selected and body-referenced draft attachments', async () => {
  const updates: any[] = [];
  const firstMessage = {
    id: 'message-1',
    body: '<img src="/api/attachments/att-body/download">',
  };
  const ticket = {
    id: 'ticket-1',
    ticketNo: 'WO-1',
    title: 'fixture',
    requesterId: 'requester',
    assigneeId: null,
    status: 'NEW',
    createdAt: new Date(),
    participants: [],
    messages: [],
    tags: [],
  };
  const tx = {
    ticketAttachment: {
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      },
    },
    ticketMessage: { findFirst: async () => firstMessage },
  };
  const prisma: any = {
    ticket: {
      findFirst: async () => null,
      create: async () => ticket,
      update: async () => ticket,
      findUnique: async () => ({
        ...ticket,
        requester: { id: 'requester', name: 'R', email: 'r@example.com' },
        assignee: null,
        queue: null,
        type: null,
        category: null,
        datacenter: null,
        cluster: null,
      }),
    },
    ticketHistory: { create: async () => ({}) },
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  const service = new TicketsService(
    prisma,
    { availableActions: () => [] } as any,
    {} as any,
    { schedule: async () => ({}) } as any,
    {} as any,
  );

  await service.create(requester, {
    title: 'fixture',
    body: '<img src="/api/attachments/att-body/download">',
    attachmentIds: ['att-file'],
  } as any);

  // 1) attachmentIds 先挂工单；2) 再绑定到首条消息；3) 正文引用补挂工单；
  // 4) linkReferencedAttachments 把正文内联图绑定到首条消息。
  assert.deepEqual(updates[0].where.id, { in: ['att-file'] });
  assert.deepEqual(updates[0].data, { ticketId: 'ticket-1' });
  assert.deepEqual(updates[1].where.id, { in: ['att-file'] });
  assert.deepEqual(updates[1].data, { messageId: 'message-1' });
  assert.deepEqual(updates[2].where.id, { in: ['att-body'] });
  assert.deepEqual(updates[2].data, { ticketId: 'ticket-1' });
  assert.deepEqual(updates[3].where.id, { in: ['att-body'] });
  assert.deepEqual(updates[3].data, { messageId: 'message-1' });
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
        if (args.data.ticketId) {
          assert.equal(inTransaction, true);
          events.push('claim-draft');
          return { count: 0 };
        }
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
    {
      queueObjectDeletions: async () => 0,
      processPendingDeletions: async () => ({ deleted: 0, retrying: 0 }),
    } as any,
  );

  const message = await service.addMessage(requester, 'ticket-1', {
    body: '<p>see <img src="/api/attachments/att-1/download"></p>',
  } as any);
  assert.equal((message as any).id, 'message-1');
  assert.deepEqual(events, ['begin', 'claim-draft', 'bind', 'commit']);
});
