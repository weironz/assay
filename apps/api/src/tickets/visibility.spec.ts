import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthUser } from '../auth/auth.types';
import {
  canManageParticipants,
  canOperateTicket,
  canReadAllTickets,
  canViewTicket,
  isInternalParticipant,
  isTicketCollaborator,
  ticketVisibilityWhere,
} from './visibility';

let seq = 0;
function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: `u-${++seq}`,
    email: 'u@example.test',
    name: 'U',
    username: null,
    image: null,
    emailVerified: true,
    twoFactorEnabled: false,
    status: 'ACTIVE',
    defaultContact: null,
    authType: 'session',
    roles: ['requester'],
    permissions: ['ticket:read', 'ticket:create'],
    ...overrides,
  };
}

const ticket = {
  requesterId: 'requester-1',
  assigneeId: 'assignee-1',
  participants: [
    { userId: 'collab-1', role: 'COLLABORATOR' },
    { userId: 'follower-1', role: 'FOLLOWER' },
  ],
};

test('ticketVisibilityWhere: read:all 看全部，否则只看本人相关工单', () => {
  const admin = user({ permissions: ['ticket:read:all'] });
  assert.deepEqual(ticketVisibilityWhere(admin), {});

  const plain = user();
  assert.deepEqual(ticketVisibilityWhere(plain), {
    OR: [
      { requesterId: plain.id },
      { assigneeId: plain.id },
      { participants: { some: { userId: plain.id } } },
    ],
  });
});

test('canViewTicket 与 ticketVisibilityWhere 语义一致（内存版对 where 版）', () => {
  const readAll = user({ permissions: ['ticket:read:all'] });
  const requester = user({ id: 'requester-1' });
  const assignee = user({ id: 'assignee-1' });
  const collaborator = user({ id: 'collab-1' });
  const follower = user({ id: 'follower-1' });
  const outsider = user();

  for (const [viewer, expected] of [
    [readAll, true],
    [requester, true],
    [assignee, true],
    [collaborator, true],
    [follower, true],
    [outsider, false],
  ] as const) {
    assert.equal(canViewTicket(viewer, ticket), expected, `${viewer.id} 的可见性`);
  }
});

test('canReadAllTickets 只认 ticket:read:all 数据范围', () => {
  assert.equal(canReadAllTickets(user({ permissions: ['ticket:read:all'] })), true);
  assert.equal(canReadAllTickets(user({ permissions: ['ticket:read'] })), false);
});

test('isTicketCollaborator 只认 COLLABORATOR 角色，FOLLOWER 不算', () => {
  assert.equal(isTicketCollaborator(user({ id: 'collab-1' }), ticket), true);
  assert.equal(isTicketCollaborator(user({ id: 'follower-1' }), ticket), false);
  assert.equal(isTicketCollaborator(user(), ticket), false);
});

test('isInternalParticipant: 管理岗/处理人/协作成员可见内部备注；read:all 与提单人不可见', () => {
  assert.equal(isInternalParticipant(user({ roles: ['admin'] }), ticket), true);
  assert.equal(isInternalParticipant(user({ roles: ['supervisor'] }), ticket), true);
  assert.equal(isInternalParticipant(user({ id: 'assignee-1' }), ticket), true);
  assert.equal(isInternalParticipant(user({ id: 'collab-1' }), ticket), true);
  assert.equal(isInternalParticipant(user({ permissions: ['ticket:read:all'] }), ticket), false);
  assert.equal(isInternalParticipant(user({ id: 'requester-1' }), ticket), false);
  assert.equal(isInternalParticipant(user({ id: 'follower-1' }), ticket), false);
});

test('canOperateTicket: 管理岗可操作任意工单，其他人只能操作本人相关；read:all 不授予写', () => {
  assert.equal(canOperateTicket(user({ roles: ['admin'] }), ticket), true);
  assert.equal(canOperateTicket(user({ roles: ['supervisor'] }), ticket), true);
  assert.equal(canOperateTicket(user({ id: 'requester-1' }), ticket), true);
  assert.equal(canOperateTicket(user({ id: 'assignee-1' }), ticket), true);
  assert.equal(canOperateTicket(user({ permissions: ['ticket:read:all'] }), ticket), false);
  assert.equal(canOperateTicket(user({ id: 'collab-1' }), ticket), false);
  assert.equal(canOperateTicket(user(), ticket), false);
});

test('canManageParticipants: 管理岗或当前处理人才能管理协作成员', () => {
  assert.equal(canManageParticipants(user({ roles: ['admin'] }), ticket), true);
  assert.equal(canManageParticipants(user({ roles: ['supervisor'] }), ticket), true);
  assert.equal(canManageParticipants(user({ id: 'assignee-1' }), ticket), true);
  assert.equal(canManageParticipants(user({ id: 'requester-1' }), ticket), false);
  assert.equal(canManageParticipants(user({ id: 'collab-1' }), ticket), false);
});
