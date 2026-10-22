import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';

/**
 * 工单可见性与操作权限的唯一定义。
 *
 * 曾经这套规则在 6 个文件里复制了 8 份，口径漂移出过一次真实 bug：
 * 仪表盘统计漏掉了协作成员。任何改动只许在这里发生，调用点一律 import。
 *
 * 注意 ticket:read:all 是独立的「读全部」数据范围：它放宽查看，
 * 但不自动授予任何写操作，所以 canOperateTicket 刻意不把它算进去。
 */

export interface TicketParticipantRef {
  userId: string;
  /** canViewTicket 不需要角色；协作/内部判定才用到。 */
  role?: string;
}

export interface TicketAccess {
  requesterId: string;
  assigneeId: string | null;
  participants?: TicketParticipantRef[];
}

/** canViewTicket 用不上角色；需要角色判定（协作/内部备注）的调用方必须用这个形状。 */
export interface TicketRoleAccess {
  requesterId: string;
  assigneeId: string | null;
  participants: { userId: string; role: string }[];
}

/** 数据范围权限：允许读取全部工单，但不自动授予任何写操作。 */
export function canReadAllTickets(user: AuthUser): boolean {
  return user.permissions.includes('ticket:read:all');
}

/** 列表/统计的 Prisma where：全局只读全看，否则看本人关联或被邀请协作的工单。 */
export function ticketVisibilityWhere(
  user: AuthUser,
): Prisma.TicketWhereInput {
  if (canReadAllTickets(user)) {
    return {};
  }
  return {
    OR: [
      { requesterId: user.id },
      { assigneeId: user.id },
      { participants: { some: { userId: user.id } } },
    ],
  };
}

/** 单单的内存判定，必须与 ticketVisibilityWhere 语义一致。 */
export function canViewTicket(user: AuthUser, ticket: TicketAccess): boolean {
  if (canReadAllTickets(user)) return true;
  return (
    ticket.requesterId === user.id ||
    ticket.assigneeId === user.id ||
    !!ticket.participants?.some((participant) => participant.userId === user.id)
  );
}

/** 协作成员（区别于只关注的 FOLLOWER）。调用方必须 select 出 participants.role。 */
export function isTicketCollaborator(
  user: AuthUser,
  ticket: { participants?: { userId: string; role: string }[] },
): boolean {
  return !!ticket.participants?.some(
    (participant) =>
      participant.userId === user.id && participant.role === 'COLLABORATOR',
  );
}

/** 谁能看内部备注：管理岗、当前处理人、协作成员。仅有 ticket:read:all 的只读账号也不行。 */
export function isInternalParticipant(
  user: AuthUser,
  ticket: {
    assigneeId: string | null;
    participants?: { userId: string; role: string }[];
  },
): boolean {
  return (
    user.roles.includes('admin') ||
    user.roles.includes('supervisor') ||
    ticket.assigneeId === user.id ||
    isTicketCollaborator(user, ticket)
  );
}

/** 谁能管理协作成员：管理岗或当前处理人。 */
export function canManageParticipants(
  user: AuthUser,
  ticket: { assigneeId: string | null },
): boolean {
  return (
    user.roles.includes('admin') ||
    user.roles.includes('supervisor') ||
    ticket.assigneeId === user.id
  );
}

/**
 * 写操作边界：管理岗可处理全部工单，其他人只能操作与自己相关的工单。
 * 不把 ticket:read:all 混进这里，避免“全局只读”意外变成全局可编辑。
 */
export function canOperateTicket(
  user: AuthUser,
  ticket: { requesterId: string; assigneeId: string | null },
): boolean {
  if (user.roles.includes('admin') || user.roles.includes('supervisor')) return true;
  return ticket.requesterId === user.id || ticket.assigneeId === user.id;
}
