import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTicketsService } from './tickets-service.fixture';

/**
 * #30 回归：编辑消息仅限原作者本人。
 *
 * 旧实现给 admin / supervisor 开了作者校验豁免（授权查询不带 authorId），
 * 这里锁定：任何角色的授权查询都恒带 authorId: user.id，越权一律 403，
 * 且不触碰正文更新、附件重新绑定、成功审计记录。
 */

const TICKET_ID = 'ticket-1';
const MESSAGE_ID = 'message-1';
const AUTHOR_ID = 'author-a';
const EDIT_BODY = '<p>edited</p>';
// update 的返回值带正文引用，成功路径会据此触发 linkReferencedAttachments；
// 越权路径在授权阶段就抛 403，不会走到这里。
const UPDATED_BODY = '<p>edited</p><img src="/api/attachments/att-1/download">';

interface User {
  id: string;
  roles: string[];
  permissions: string[];
}

const user = (
  id: string,
  roles: string[],
  permissions: string[] = ['ticket:read', 'ticket:comment'],
): User => ({ id, roles, permissions });

// 消息作者 A 同时是协作成员（内部参与方），但绝不是 admin / supervisor。
const author = user(AUTHOR_ID, ['handler']);
const userB = user('user-b', ['requester']); // 关注人：能看单、非内部参与方
const handler = user('handler', ['handler']); // 主处理人：内部参与方
const collaborator = user('collaborator', ['handler']); // 协作成员：内部参与方
const requester = user('requester', ['requester']); // 提单人：非内部参与方
const supervisor = user('supervisor', ['supervisor'], [
  'ticket:read',
  'ticket:comment',
  'ticket:read:all',
]);
const admin = user('admin', ['admin'], [
  'ticket:read',
  'ticket:comment',
  'ticket:read:all',
]);

// 一张让上述所有角色都能通过 canViewTicket 的工单（否则会在进事务前被快速失败，
// 就无法验证事务内授权查询的 where 恒含 authorId）。
const ticket = {
  id: TICKET_ID,
  requesterId: 'requester',
  assigneeId: 'handler',
  participants: [
    { userId: AUTHOR_ID, role: 'COLLABORATOR' },
    { userId: 'user-b', role: 'FOLLOWER' },
    { userId: 'collaborator', role: 'COLLABORATOR' },
  ],
};

interface MessageMeta {
  id: string;
  ticketId: string;
  authorId: string;
  isInternal: boolean;
}

const publicMessageByA: MessageMeta = {
  id: MESSAGE_ID,
  ticketId: TICKET_ID,
  authorId: AUTHOR_ID,
  isInternal: false,
};
const internalNoteByA: MessageMeta = {
  id: MESSAGE_ID,
  ticketId: TICKET_ID,
  authorId: AUTHOR_ID,
  isInternal: true,
};

/**
 * 内存版 prisma：ticket 在事务外/事务内各查一次；ticketMessage.findFirst 用
 * select 区分「授权查询」({ id: true }) 与「区分 403 的元数据查询」
 * ({ authorId, isInternal })，并按 where 真实模拟数据库的过滤结果。
 */
function harness(ticketRow: any, message: MessageMeta | null) {
  const calls = {
    findFirst: [] as any[],
    update: [] as any[],
    attachmentUpdateMany: [] as any[],
    historyCreate: [] as any[],
  };
  const prisma: any = {
    ticket: { findUnique: async () => ticketRow },
    ticketMessage: {
      findFirst: async (args: any) => {
        calls.findFirst.push(args);
        const isAuthorizedQuery =
          args.select?.id === true && args.select?.authorId === undefined;
        if (isAuthorizedQuery) {
          if (!message) return null;
          const { where } = args;
          if (where.id !== message.id || where.ticketId !== message.ticketId) return null;
          if (message.authorId !== where.authorId) return null;
          if (where.isInternal === false && message.isInternal) return null;
          return { id: message.id };
        }
        if (!message) return null;
        return { authorId: message.authorId, isInternal: message.isInternal };
      },
      update: async (args: any) => {
        calls.update.push(args);
        return { id: MESSAGE_ID, body: UPDATED_BODY, author: { id: AUTHOR_ID } };
      },
    },
    ticketAttachment: {
      updateMany: async (args: any) => {
        calls.attachmentUpdateMany.push(args);
        return { count: 0 };
      },
    },
    ticketHistory: {
      create: async (args: any) => {
        calls.historyCreate.push(args);
        return {};
      },
    },
  };
  prisma.$transaction = async (work: (tx: any) => Promise<unknown>) => work(prisma);
  const service = createTicketsService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, calls };
}

type Calls = ReturnType<typeof harness>['calls'];

/** 越权请求不得产生任何写副作用。 */
function assertNoWrites(calls: Calls) {
  assert.equal(calls.update.length, 0, '越权不得更新消息正文');
  assert.equal(calls.attachmentUpdateMany.length, 0, '越权不得重新绑定附件');
  assert.equal(calls.historyCreate.length, 0, '越权不得写成功审计记录');
}

/** 成功编辑必须原子完成：正文更新 + 附件重新绑定 + 成功审计记录。 */
function assertSuccessfulEdit(calls: Calls, actorId: string) {
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].where.id, MESSAGE_ID);
  assert.equal(calls.update[0].data.body, EDIT_BODY);
  assert.equal(calls.attachmentUpdateMany.length, 2);
  assert.deepEqual(calls.attachmentUpdateMany[0].data, { ticketId: TICKET_ID });
  assert.deepEqual(calls.attachmentUpdateMany[1].data, { messageId: MESSAGE_ID });
  assert.equal(calls.historyCreate.length, 1);
  assert.deepEqual(calls.historyCreate[0].data, {
    ticketId: TICKET_ID,
    userId: actorId,
    action: 'UPDATE',
    field: 'message',
    oldValue: null,
    newValue: '编辑消息',
  });
}

test('普通作者编辑自己公开消息成功', async () => {
  const { service, calls } = harness(ticket, publicMessageByA);
  const updated: any = await service.updateMessage(
    author,
    TICKET_ID,
    MESSAGE_ID,
    { body: EDIT_BODY } as any,
  );
  assert.equal(updated.id, MESSAGE_ID);
  assert.deepEqual(calls.findFirst[0].where, {
    id: MESSAGE_ID,
    ticketId: TICKET_ID,
    authorId: AUTHOR_ID,
  });
  assert.deepEqual(calls.findFirst[0].select, { id: true });
  assertSuccessfulEdit(calls, AUTHOR_ID);
});

test('admin 编辑自己发送的消息成功', async () => {
  const ownMessage: MessageMeta = {
    id: MESSAGE_ID,
    ticketId: TICKET_ID,
    authorId: 'admin',
    isInternal: false,
  };
  const { service, calls } = harness(ticket, ownMessage);
  const updated: any = await service.updateMessage(
    admin,
    TICKET_ID,
    MESSAGE_ID,
    { body: EDIT_BODY } as any,
  );
  assert.equal(updated.id, MESSAGE_ID);
  // admin 同样受作者归属约束，授权查询恒带 authorId。
  assert.deepEqual(calls.findFirst[0].where, {
    id: MESSAGE_ID,
    ticketId: TICKET_ID,
    authorId: 'admin',
  });
  assertSuccessfulEdit(calls, 'admin');
});

const unauthorizedEditors = [
  { name: '普通用户 B', user: userB, internal: false },
  { name: '处理人', user: handler, internal: true },
  { name: '协作人', user: collaborator, internal: true },
  { name: 'supervisor', user: supervisor, internal: true },
  { name: 'admin', user: admin, internal: true },
];

for (const { name, user: actor, internal } of unauthorizedEditors) {
  test(`${name} 编辑 A 的消息返回 403 且授权查询恒带 authorId`, async () => {
    const { service, calls } = harness(ticket, publicMessageByA);
    await assert.rejects(
      service.updateMessage(actor, TICKET_ID, MESSAGE_ID, { body: EDIT_BODY } as any),
      (err: any) => {
        assert.equal(err.status, 403);
        assert.equal(err.message, '只能编辑自己的消息');
        return true;
      },
    );
    const expectedWhere: any = {
      id: MESSAGE_ID,
      ticketId: TICKET_ID,
      authorId: actor.id,
    };
    if (!internal) expectedWhere.isInternal = false;
    assert.equal(calls.findFirst.length, 2, '授权查询 + 元数据查询各一次');
    assert.deepEqual(calls.findFirst[0].where, expectedWhere);
    assert.deepEqual(calls.findFirst[0].select, { id: true });
    assert.deepEqual(calls.findFirst[1].where, { id: MESSAGE_ID, ticketId: TICKET_ID });
    assert.deepEqual(calls.findFirst[1].select, {
      authorId: true,
      isInternal: true,
    });
    assertNoWrites(calls);
  });
}

test('非内部参与者不能编辑或探测内部备注', async () => {
  const { service, calls } = harness(ticket, internalNoteByA);
  await assert.rejects(
    service.updateMessage(requester, TICKET_ID, MESSAGE_ID, { body: EDIT_BODY } as any),
    (err: any) => {
      assert.equal(err.status, 403);
      return true;
    },
  );
  // 内部备注可见性规则保留：非内部参与者的授权查询额外限定 isInternal: false。
  assert.deepEqual(calls.findFirst[0].where, {
    id: MESSAGE_ID,
    ticketId: TICKET_ID,
    authorId: 'requester',
    isInternal: false,
  });
  assert.deepEqual(calls.findFirst[0].select, { id: true });
  assert.deepEqual(calls.findFirst[1].select, {
    authorId: true,
    isInternal: true,
  });
  // 授权查询与元数据查询都只取 id / 元数据，任何一步都不把内部备注正文读出来。
  for (const query of calls.findFirst) {
    assert.equal(query.select.body, undefined);
  }
  assertNoWrites(calls);
});

test('已被移出工单的原作者仍不能编辑历史消息', async () => {
  const removedTicket = {
    id: TICKET_ID,
    requesterId: 'someone-else',
    assigneeId: null,
    participants: [],
  };
  // 原作者已不在 requester / assignee / participants，且没有 ticket:read:all。
  const removedAuthor = user(AUTHOR_ID, ['handler']);
  const { service, calls } = harness(removedTicket, publicMessageByA);
  await assert.rejects(
    service.updateMessage(removedAuthor, TICKET_ID, MESSAGE_ID, { body: EDIT_BODY } as any),
    (err: any) => {
      assert.equal(err.status, 403);
      assert.equal(err.message, '无权查看该工单');
      return true;
    },
  );
  assert.equal(calls.findFirst.length, 0, 'canViewTicket 快速失败，不得进入消息查询');
  assertNoWrites(calls);
});
