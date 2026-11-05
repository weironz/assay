import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TicketQueries } from '../src/tickets/ticket-queries';
import { ticketVisibilityWhere } from '../src/tickets/visibility';

// 普通提单人：非内部参与方，只能看与自己关联的工单。
const requester = {
  id: 'requester',
  roles: ['requester'],
  permissions: ['ticket:read'],
} as any;

// 仅有「读全部」数据范围、但非管理岗的只读账号：能看全部工单，
// 仍不能看内部备注（visibility.ts 明确区分 read:all 与内部备注可见性）。
const readOnly = {
  id: 'auditor',
  roles: ['auditor'],
  permissions: ['ticket:read:all'],
} as any;

// 管理岗：全局能看内部备注。
const admin = {
  id: 'admin',
  roles: ['admin'],
  permissions: ['ticket:read:all'],
} as any;

const VISIBILITY_REQUESTER = {
  OR: [
    { requesterId: 'requester' },
    { assigneeId: 'requester' },
    { participants: { some: { userId: 'requester' } } },
  ],
};

interface Calls {
  findMany?: any;
  count?: any;
}

function capture() {
  const calls: Calls = {};
  const prisma: any = {
    ticket: {
      findMany: async (args: any) => {
        calls.findMany = args;
        return [];
      },
      count: async (args: any) => {
        calls.count = args;
        return 0;
      },
    },
  };
  return { calls, queries: new TicketQueries(prisma, {} as any) };
}

async function listWhere(user: any, q: any): Promise<Calls> {
  const { calls, queries } = capture();
  await queries.list(user, q);
  return calls;
}

/** 关键字过滤始终作为 AND 的第二个 conjunct（第一个是可见范围）。 */
function keywordOr(where: any): any[] | undefined {
  return where.AND ? where.AND[1].OR : undefined;
}

/** 取出 OR 里的正文匹配条件 messages.some，空/纯空白关键字时为 undefined。 */
function messageCondition(where: any): any {
  const hit = (keywordOr(where) ?? []).find((condition: any) => condition.messages);
  return hit?.messages?.some;
}

test('keyword 命中工单消息正文：OR 增加 messages.some.body.contains (insensitive)', async () => {
  const { count, findMany } = await listWhere(requester, { keyword: 'disk' });
  const expectedWhere = {
    AND: [
      VISIBILITY_REQUESTER,
      {
        OR: [
          { title: { contains: 'disk', mode: 'insensitive' } },
          { ticketNo: { contains: 'disk', mode: 'insensitive' } },
          {
            messages: {
              some: {
                body: { contains: 'disk', mode: 'insensitive' },
                isInternal: false,
              },
            },
          },
        ],
      },
    ],
  };
  assert.deepEqual(count.where, expectedWhere);
  assert.deepEqual(findMany.where, expectedWhere);
});

test('顶层 AND 仍含 ticketVisibilityWhere 结果，搜索条件与之同级（未提到顶层 OR）', async () => {
  const { count } = await listWhere(requester, { keyword: 'disk' });
  const where = count.where;
  assert.ok(Array.isArray(where.AND), 'filters 必须以 AND 组合');
  assert.equal(where.AND.length, 2);
  // 第一个 conjunct 就是可见范围，逐字与 visibility.ts 的输出一致。
  assert.deepEqual(where.AND[0], ticketVisibilityWhere(requester));
  assert.deepEqual(where.AND[0], VISIBILITY_REQUESTER);
  // 顶层不应出现 OR：可见范围的 OR 被 AND 包裹，不会被关键字 OR 覆盖、放大可见范围。
  assert.equal(where.OR, undefined);
  // 搜索 OR 独立作为第二个 conjunct，没有把权限条件并进去。
  assert.ok(Array.isArray(where.AND[1].OR));
  assert.equal(where.AND[1].OR.length, 3);
});

test('findMany 与 count 使用同一个 where 对象，total 口径不泄漏正文命中', async () => {
  const { findMany, count } = await listWhere(requester, { keyword: 'disk' });
  assert.strictEqual(
    findMany.where,
    count.where,
    'findMany 与 count 必须是同一 where 引用，避免只过滤 items 而 total 泄漏',
  );
  // 内部备注不被无权用户计入 total：正文条件 + 非内部约束都在这个 where 里，
  // 两个查询完全一致，没有旁路。
  assert.equal(count.where.AND[1].OR[2].messages.some.isInternal, false);
});

test('非内部参与方的消息子查询限定 isInternal:false（含仅有 ticket:read:all 的只读账号）', async () => {
  for (const user of [requester, readOnly]) {
    const { count } = await listWhere(user, { keyword: 'disk' });
    const some = messageCondition(count.where);
    assert.ok(some, `${user.id} 应存在正文匹配条件`);
    assert.equal(some.isInternal, false, `${user.id} 不得通过内部备注命中或推断其存在`);
    assert.deepEqual(some.body, { contains: 'disk', mode: 'insensitive' });
  }
});

test('管理岗的消息子查询不限制 isInternal，可命中内部备注', async () => {
  const { count } = await listWhere(admin, { keyword: 'disk' });
  const some = messageCondition(count.where);
  assert.deepEqual(some, { body: { contains: 'disk', mode: 'insensitive' } });
  assert.equal(some.isInternal, undefined);
  // admin 的可见范围为 {}（读全部），仍与搜索条件以 AND 同级组合。
  assert.deepEqual(count.where.AND[0], {});
});

test('含非空白字符的关键字（带前后空格）仍扩展到正文，contains 用原值', async () => {
  const { count } = await listWhere(requester, { keyword: ' disk ' });
  const some = messageCondition(count.where);
  assert.deepEqual(some.body, { contains: ' disk ', mode: 'insensitive' });
  assert.equal(some.isInternal, false);
});

test('空关键字不新增正文条件：where 退化为可见范围本身（与改动前一致）', async () => {
  const { count } = await listWhere(requester, { keyword: '' });
  assert.deepEqual(count.where, VISIBILITY_REQUESTER);
  assert.equal(messageCondition(count.where), undefined);
  assert.equal(JSON.stringify(count.where).includes('messages'), false);
});

test('纯空白关键字不改变原有行为：仍只按 title/ticketNo 匹配，不新增正文条件', async () => {
  const { count } = await listWhere(requester, { keyword: '   ' });
  assert.deepEqual(count.where, {
    AND: [
      VISIBILITY_REQUESTER,
      {
        OR: [
          { title: { contains: '   ', mode: 'insensitive' } },
          { ticketNo: { contains: '   ', mode: 'insensitive' } },
        ],
      },
    ],
  });
  assert.equal(messageCondition(count.where), undefined);
  assert.equal(count.where.AND[1].OR.length, 2);
  assert.equal(JSON.stringify(count.where).includes('messages'), false);
});
