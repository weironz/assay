import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELETION_ALERT_AFTER,
  enqueueObjectDeletions,
  processObjectDeletions,
} from '../src/attachments/deletion-queue';

function fakeQueue(seed: Array<{ id: string; objectKey: string; attempts?: number }> = []) {
  const tasks = new Map<string, any>();
  for (const item of seed) {
    tasks.set(item.id, {
      id: item.id,
      objectKey: item.objectKey,
      attempts: item.attempts ?? 0,
      lastError: null,
      nextAttemptAt: new Date(0),
      createdAt: new Date(0),
    });
  }
  const model = {
    createMany: async ({ data }: any) => {
      for (const row of data) {
        const id = `task-${tasks.size + 1}`;
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
      return [...tasks.values()]
        .filter((task) => task.nextAttemptAt.getTime() <= limit)
        .map((task) => ({
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
      if (!task) throw new Error(`missing task ${where.id}`);
      Object.assign(task, data);
      return task;
    },
    deleteMany: async ({ where }: any) => {
      const existed = tasks.delete(where.id);
      return { count: existed ? 1 : 0 };
    },
  };
  return { tasks, model };
}

test('enqueueObjectDeletions deduplicates keys and skips empty input', async () => {
  const rows: any[] = [];
  const db = {
    attachmentDeletionTask: {
      createMany: async ({ data }: any) => {
        rows.push(...data);
        return { count: data.length };
      },
    },
  };

  assert.equal(
    await enqueueObjectDeletions(
      db as any,
      ['a', 'a', '', 'b'],
      'TEST',
      new Date('2026-01-02T00:00:00.000Z'),
    ),
    2,
  );
  assert.deepEqual(rows.map((row) => row.objectKey), ['a', 'b']);
  assert.ok(rows.every((row) => row.reason === 'TEST'));
  assert.equal(rows[0].nextAttemptAt.toISOString(), '2026-01-02T00:00:00.000Z');

  assert.equal(await enqueueObjectDeletions(db as any, [], 'TEST'), 0);
  assert.equal(rows.length, 2);
});

test('processObjectDeletions removes tasks whose object was deleted', async () => {
  const queue = fakeQueue([{ id: 'task-a', objectKey: 'key-a' }]);
  const deleted: string[] = [];
  const errors: string[] = [];

  const result = await processObjectDeletions(
    { attachmentDeletionTask: queue.model } as any,
    { delete: async (key: string) => void deleted.push(key) },
    {
      error: (message: string) => void errors.push(message),
    } as any,
  );

  assert.deepEqual(result, { deleted: 1, retrying: 0 });
  assert.deepEqual(deleted, ['key-a']);
  assert.equal(queue.tasks.size, 0);
  assert.deepEqual(errors, []);
});

test('processObjectDeletions keeps failed tasks, records the error and backs off', async () => {
  const queue = fakeQueue([{ id: 'task-a', objectKey: 'key-a' }]);
  const errors: string[] = [];
  const now = new Date('2026-01-02T00:00:00.000Z');

  const result = await processObjectDeletions(
    { attachmentDeletionTask: queue.model } as any,
    {
      delete: async () => {
        throw new Error('s3 unavailable');
      },
    },
    {
      error: (message: string) => void errors.push(message),
    } as any,
    now,
  );

  assert.deepEqual(result, { deleted: 0, retrying: 1 });
  const task = queue.tasks.get('task-a');
  assert.equal(task.attempts, 1);
  assert.match(task.lastError, /s3 unavailable/);
  assert.ok(task.nextAttemptAt.getTime() > now.getTime());
  assert.equal(errors.length, 1);
  assert.match(errors[0], /已安排重试/);
});

test('repeated failures escalate to an error log for alerting', async () => {
  const queue = fakeQueue([
    { id: 'task-a', objectKey: 'key-a', attempts: DELETION_ALERT_AFTER - 1 },
  ]);
  const errors: string[] = [];

  await processObjectDeletions(
    { attachmentDeletionTask: queue.model } as any,
    {
      delete: async () => {
        throw new Error('still unavailable');
      },
    },
    {
      warn: () => undefined,
      error: (message: string) => void errors.push(message),
    } as any,
  );

  assert.equal(queue.tasks.get('task-a').attempts, DELETION_ALERT_AFTER);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /需要人工处理/);
  assert.match(errors[0], /key-a/);
});

test('a task leased by another worker is skipped until the lease expires', async () => {
  const queue = fakeQueue([{ id: 'task-a', objectKey: 'key-a' }]);
  queue.tasks.get('task-a').nextAttemptAt = new Date('2099-01-01T00:00:00.000Z');
  let deletes = 0;

  const result = await processObjectDeletions(
    { attachmentDeletionTask: queue.model } as any,
    {
      delete: async () => {
        deletes += 1;
      },
    },
    { warn: () => undefined, error: () => undefined } as any,
    new Date('2026-01-02T00:00:00.000Z'),
  );

  assert.deepEqual(result, { deleted: 0, retrying: 0 });
  assert.equal(deletes, 0);
  assert.equal(queue.tasks.size, 1);
});
