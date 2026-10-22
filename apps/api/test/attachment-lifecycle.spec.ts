import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AttachmentsService } from '../src/attachments/attachments.service';
import { AttachmentMaintenanceService } from '../src/attachments/attachment-maintenance.service';
import { createTicketsService } from './tickets-service.fixture';
import {
  DRAFT_TTL_HOURS,
  MAX_ATTACHMENTS_PER_TICKET,
  MAX_ATTACHMENT_BYTES,
  MAX_DAILY_UPLOADS,
  RASTER_IMAGE_EXTS,
  extForRasterMime,
  mimeForRasterExt,
} from '../src/attachments/limits';

const tmpDir = mkdtempSync(join(tmpdir(), 'assay-attachment-'));

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

const staff = {
  id: 'staff',
  roles: ['handler'],
  permissions: ['ticket:read'],
} as any;

/** 真实落一个临时文件：service 会把它交给 storage.putStream 并在 finally 里删除。 */
const upload = (name = 'note.txt', size = 10) => {
  const path = join(tmpDir, `${Math.random().toString(36).slice(2)}-${name}`);
  writeFileSync(path, 'fixture');
  return { path, originalname: name, size } as any;
};

/** 读掉流，避免测试里留下未消费的 fd。 */
const drain = async (body: AsyncIterable<unknown>) => {
  for await (const _chunk of body) {
    // 只为关闭句柄
  }
};

/**
 * 内存版删除 outbox：模拟后台 worker 需要的 findMany/领取/更新/出队语义。
 * nextAttemptAt 使用入队时传入的时间（没传则用 epoch 0），这样能覆盖
 * 「sweep 刚写入的任务必须用提交后的时间领取」这一时序。
 */
function deletionQueueMock() {
  const tasks = new Map<string, any>();
  let sequence = 0;
  const taskModel = {
    createMany: async ({ data }: any) => {
      for (const row of data) {
        const id = `task-${++sequence}`;
        tasks.set(id, {
          id,
          objectKey: row.objectKey,
          reason: row.reason,
          attempts: 0,
          lastError: null,
          nextAttemptAt: row.nextAttemptAt ?? new Date(0),
          createdAt: new Date(0),
        });
      }
      return { count: data.length };
    },
    findMany: async (args: any = {}) => {
      const limit = args.where?.nextAttemptAt?.lte?.getTime?.() ?? Infinity;
      const rows = [...tasks.values()]
        .filter((task) => task.nextAttemptAt.getTime() <= limit)
        .slice(0, args.take ?? Infinity);
      return rows.map((task) => ({
        id: task.id,
        objectKey: task.objectKey,
        attempts: task.attempts,
      }));
    },
    updateMany: async ({ where, data }: any) => {
      const task = tasks.get(where.id);
      if (!task) return { count: 0 };
      if (
        where.nextAttemptAt?.lte &&
        task.nextAttemptAt.getTime() > where.nextAttemptAt.lte.getTime()
      ) {
        return { count: 0 };
      }
      if (data.attempts?.increment) task.attempts += data.attempts.increment;
      if (data.nextAttemptAt) task.nextAttemptAt = data.nextAttemptAt;
      return { count: 1 };
    },
    update: async ({ where, data }: any) => {
      const task = tasks.get(where.id);
      if (!task) throw new Error(`missing deletion task ${where.id}`);
      Object.assign(task, data);
      return task;
    },
    deleteMany: async ({ where }: any) => {
      const existed = tasks.delete(where.id);
      return { count: existed ? 1 : 0 };
    },
  };
  return { tasks, taskModel };
}

const emptyStorage = () => ({
  putStream: async ({ body }: any) => drain(body),
}) as any;

function uploadPrisma(overrides: { count?: number; uploads?: number; create?: () => Promise<any> } = {}) {
  const prisma: any = {
    ticket: { findUnique: async () => ticketAccess },
    ticketMessage: { findMany: async () => [] },
    ticketAttachment: {
      count: async () => overrides.count ?? 0,
      aggregate: async () => ({
        _count: { _all: overrides.uploads ?? 0 },
        _sum: { fileSize: 0 },
      }),
      create:
        overrides.create ??
        (async (args: any) => ({ id: 'attachment-new', ...args.data })),
    },
    // 上传前先登记待删除，成功后在同一事务里撤销；失败的测试会覆盖这些方法。
    attachmentDeletionTask: {
      createMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) =>
    work(prisma);
  return prisma;
}

test('upload rejects a file above the single-file limit before writing to storage', async () => {
  let puts = 0;
  const service = new AttachmentsService(uploadPrisma(), {
    putStream: async () => {
      puts += 1;
    },
  } as any);

  await assert.rejects(
    service.upload(requester, 'ticket-1', upload('note.txt', MAX_ATTACHMENT_BYTES + 1)),
    { status: 413 },
  );
  assert.equal(puts, 0);
});

test('upload enforces the per-ticket attachment count on the server', async () => {
  const service = new AttachmentsService(
    uploadPrisma({ count: MAX_ATTACHMENTS_PER_TICKET }),
    emptyStorage(),
  );

  await assert.rejects(service.upload(requester, 'ticket-1', upload()), {
    status: 400,
  });
});

test('upload enforces the per-user daily upload count', async () => {
  const service = new AttachmentsService(
    uploadPrisma({ uploads: MAX_DAILY_UPLOADS }),
    emptyStorage(),
  );

  await assert.rejects(service.upload(requester, 'ticket-1', upload()), {
    status: 400,
  });
});

test('failed DB insert removes the object already written to storage', async () => {
  const stored: string[] = [];
  const deleted: string[] = [];
  const prisma = uploadPrisma({
    create: async () => {
      throw new Error('db unavailable');
    },
  });
  const service = new AttachmentsService(prisma, {
    putStream: async ({ key, body }: any) => {
      stored.push(key);
      await drain(body);
    },
    delete: async (key: string) => {
      deleted.push(key);
    },
  } as any);

  await assert.rejects(service.upload(requester, 'ticket-1', upload()), /db unavailable/);
  assert.equal(stored.length, 1);
  assert.deepEqual(deleted, stored);
});

test('a failed upload rollback is persisted in the deletion outbox', async () => {
  const stored: string[] = [];
  const queued: any[] = [];
  let markedDue = 0;
  const prisma = uploadPrisma({
    create: async () => {
      throw new Error('db unavailable');
    },
  });
  prisma.attachmentDeletionTask = {
    createMany: async ({ data }: any) => {
      queued.push(...data);
      return { count: data.length };
    },
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => {
      markedDue += 1;
      return { count: 1 };
    },
  };
  const service = new AttachmentsService(prisma, {
    putStream: async ({ key, body }: any) => {
      stored.push(key);
      await drain(body);
    },
    delete: async () => {
      throw new Error('s3 unavailable');
    },
  } as any);

  await assert.rejects(service.upload(requester, 'ticket-1', upload()), /db unavailable/);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].objectKey, stored[0]);
  assert.equal(queued[0].reason, 'UPLOAD_PENDING');
  assert.ok(queued[0].nextAttemptAt.getTime() > Date.now());
  // 回删失败后把登记提前到当前时间，让后台 worker 立刻重试。
  assert.equal(markedDue, 1);
});

test('a successful upload clears the pending deletion registration', async () => {
  const events: string[] = [];
  const prisma = uploadPrisma();
  prisma.attachmentDeletionTask = {
    createMany: async () => {
      events.push('pending');
      return { count: 1 };
    },
    deleteMany: async (args: any) => {
      events.push(`clear:${args.where.reason}`);
      return { count: 1 };
    },
    updateMany: async () => ({ count: 0 }),
  };
  const service = new AttachmentsService(prisma, {
    putStream: async ({ body }: any) => drain(body),
  } as any);

  const rec = await service.upload(requester, 'ticket-1', upload());
  assert.equal(rec.id, 'attachment-new');
  assert.deepEqual(events, ['pending', 'clear:UPLOAD_PENDING']);
});

test('draft sweep queues expired drafts and deletes their objects', async () => {
  const deletedKeys: string[] = [];
  const queue = deletionQueueMock();
  let query: any;
  const prisma: any = {
    ticketAttachment: {
      findMany: async (args: any) => {
        query = args;
        return [{ id: 'draft-1', objectKey: 'tickets/draft/draft-1' }];
      },
      deleteMany: async () => ({ count: 1 }),
    },
    attachmentDeletionTask: queue.taskModel,
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) =>
    work(prisma);

  const service = new AttachmentMaintenanceService(
    prisma,
    {
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    } as any,
  );

  const now = new Date('2026-01-02T00:00:00.000Z');
  assert.equal(await service.sweep(now), 1);
  assert.equal(query.where.ticketId, null);
  assert.equal(
    query.where.createdAt.lt.getTime(),
    now.getTime() - DRAFT_TTL_HOURS * 3_600_000,
  );
  assert.deepEqual(deletedKeys, ['tickets/draft/draft-1']);
  assert.equal(queue.tasks.size, 0);
});

test('draft sweep keeps a draft that was attached to a ticket after the scan', async () => {
  let deletes = 0;
  const queue = deletionQueueMock();
  const prisma: any = {
    ticketAttachment: {
      findMany: async () => [{ id: 'draft-2', objectKey: 'tickets/draft/draft-2' }],
      // 记录在扫描之后被建单关联，带 ticketId=null 条件的删除应命中 0 行。
      deleteMany: async () => ({ count: 0 }),
    },
    attachmentDeletionTask: queue.taskModel,
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) =>
    work(prisma);

  const service = new AttachmentMaintenanceService(
    prisma,
    {
      delete: async () => {
        deletes += 1;
      },
    } as any,
  );

  assert.equal(await service.sweep(), 0);
  assert.equal(deletes, 0);
  assert.equal(queue.tasks.size, 0);
});

test('draft sweep keeps a failed object deletion in the durable outbox', async () => {
  const queue = deletionQueueMock();
  const prisma: any = {
    ticketAttachment: {
      findMany: async () => [{ id: 'draft-3', objectKey: 'tickets/draft/draft-3' }],
      deleteMany: async () => ({ count: 1 }),
    },
    attachmentDeletionTask: queue.taskModel,
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) =>
    work(prisma);

  const service = new AttachmentMaintenanceService(
    prisma,
    {
      delete: async () => {
        throw new Error('s3 unavailable');
      },
    } as any,
  );

  // 记录已从 DB 删除，但对象删除失败不能丢：任务留在 outbox 里等重试。
  assert.equal(await service.sweep(), 1);
  const pending = [...queue.tasks.values()];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].objectKey, 'tickets/draft/draft-3');
  assert.equal(pending[0].attempts, 1);
  assert.match(pending[0].lastError, /s3 unavailable/);
});

test('deleting a ticket queues object keys in the same transaction before cascade', async () => {
  const events: string[] = [];
  const prisma: any = {
    ticket: {
      findUnique: async () => ({
        id: 'ticket-1',
        requesterId: 'requester',
        assigneeId: null,
      }),
      delete: async () => {
        events.push('delete-ticket');
      },
    },
    ticketAttachment: {
      findMany: async () => {
        events.push('read-keys');
        return [{ objectKey: 'k1' }, { objectKey: 'k2' }];
      },
    },
    $transaction: async (work: (tx: any) => Promise<unknown>) => {
      events.push('begin');
      try {
        return await work(prisma);
      } finally {
        events.push('commit');
      }
    },
  };
  const service = createTicketsService(
    prisma,
    {} as any,
    { notify: async () => ({}) } as any,
    {
      cancel: async () => {
        events.push('cancel-sla');
      },
    } as any,
    {
      queueObjectDeletions: async (_tx: any, keys: string[]) => {
        events.push(`queue:${keys.join(',')}`);
      },
      processPendingDeletions: async () => {
        events.push('delete-objects:k1,k2');
      },
    } as any,
  );

  await service.remove(requester, 'ticket-1');
  assert.deepEqual(events, [
    'begin',
    'read-keys',
    'queue:k1,k2',
    'delete-ticket',
    'commit',
    'cancel-sla',
    'delete-objects:k1,k2',
  ]);
});

test('a removed collaborator can no longer edit their old message', async () => {
  let messageLookups = 0;
  const service = createTicketsService(
    {
      ticket: {
        findUnique: async () => ({
          id: 'ticket-1',
          requesterId: 'someone-else',
          assigneeId: null,
          participants: [],
        }),
      },
      ticketMessage: {
        findUnique: async () => {
          messageLookups += 1;
          return {
            id: 'message-1',
            ticketId: 'ticket-1',
            authorId: 'staff',
            isInternal: false,
          };
        },
      },
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  await assert.rejects(
    service.updateMessage(staff, 'ticket-1', 'message-1', { body: 'edited' } as any),
    { status: 403 },
  );
  assert.equal(messageLookups, 0);
});

test('an unreferenced unbound image is hidden from the requester', async () => {
  const service = new AttachmentsService(
    {
      ticket: { findUnique: async () => ticketAccess },
      ticketAttachment: {
        findUnique: async () => ({
          id: 'att-draft',
          ticketId: 'ticket-1',
          messageId: null,
          objectKey: 'tickets/draft/att-draft',
          uploaderId: 'staff',
          fileName: 'internal-draft.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      // 内部备注的草稿图还没发送：没有任何消息引用它。
      ticketMessage: { findMany: async () => [] },
    } as any,
    emptyStorage(),
  );

  await assert.rejects(service.getForDownload(requester, 'att-draft'), {
    status: 403,
  });
});

test('the uploader can still preview their own unbound image', async () => {
  const service = new AttachmentsService(
    {
      ticket: { findUnique: async () => ticketAccess },
      ticketAttachment: {
        findUnique: async () => ({
          id: 'att-mine',
          ticketId: 'ticket-1',
          messageId: null,
          objectKey: 'tickets/ticket-1/att-mine',
          uploaderId: 'requester',
          fileName: 'mine.png',
          fileSize: 1,
          mime: 'image/png',
        }),
      },
      ticketMessage: { findMany: async () => [] },
    } as any,
    { getStream: async () => ({}) } as any,
  );

  const { rec } = await service.getForDownload(requester, 'att-mine');
  assert.equal(rec.id, 'att-mine');
});

test('requester list hides other people’s unbound attachments and keeps public bindings', async () => {
  const rows = [
    {
      id: 'bound-public',
      ticketId: 'ticket-1',
      messageId: 'message-1',
      message: { isInternal: false },
      uploaderId: 'staff',
      fileName: 'public.png',
      fileSize: 1,
      mime: 'image/png',
      createdAt: new Date(),
    },
    {
      id: 'unbound-abandoned',
      ticketId: 'ticket-1',
      messageId: null,
      uploaderId: 'staff',
      fileName: 'internal.png',
      fileSize: 1,
      mime: 'image/png',
      createdAt: new Date(),
    },
    {
      id: 'unbound-referenced',
      ticketId: 'ticket-1',
      messageId: null,
      uploaderId: 'staff',
      fileName: 'legacy.png',
      fileSize: 1,
      mime: 'image/png',
      createdAt: new Date(),
    },
    {
      id: 'unbound-mine',
      ticketId: 'ticket-1',
      messageId: null,
      uploaderId: 'requester',
      fileName: 'mine.png',
      fileSize: 1,
      mime: 'image/png',
      createdAt: new Date(),
    },
  ];
  const service = new AttachmentsService(
    {
      ticket: { findUnique: async () => ticketAccess },
      ticketAttachment: { findMany: async () => rows },
      ticketMessage: {
        findMany: async () => [
          {
            isInternal: false,
            body: '<img src="/attachments/unbound-referenced/download">',
          },
        ],
      },
    } as any,
    emptyStorage(),
  );

  const list = await service.list(requester, 'ticket-1');
  assert.deepEqual(
    list.map((attachment) => attachment.id),
    ['bound-public', 'unbound-mine'],
  );
});

test('avatar MIME/ext mapping reuses the shared raster table', () => {
  assert.equal(extForRasterMime('image/jpeg'), 'jpg');
  assert.equal(extForRasterMime('image/webp'), 'webp');
  assert.equal(extForRasterMime('image/svg+xml'), null);
  assert.equal(mimeForRasterExt('jpg'), 'image/jpeg');
  assert.equal(mimeForRasterExt('webp'), 'image/webp');
  assert.deepEqual([...RASTER_IMAGE_EXTS].sort(), ['gif', 'jpg', 'png', 'webp']);
});
