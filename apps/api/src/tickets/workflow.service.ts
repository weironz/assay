import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';

export type TicketAction =
  | 'start'
  | 'hold'
  | 'resume'
  | 'resolve'
  | 'close'
  | 'reopen'
  | 'cancel';

interface Rule {
  from: TicketStatus[];
  to: TicketStatus;
  roles: string[]; // 允许的角色（满足其一）
  requireAssignee?: boolean; // 非 admin 时须为处理人
  requireRequester?: boolean; // 非 admin/supervisor 时须为提单人
}

/** 状态流转规则表（唯一真相源，详见 docs/01-设计文档.md 第 4 节） */
const RULES: Record<TicketAction, Rule> = {
  start: {
    from: ['ASSIGNED'],
    to: 'IN_PROGRESS',
    roles: ['handler', 'admin'],
    requireAssignee: true,
  },
  hold: {
    from: ['IN_PROGRESS'],
    to: 'PENDING',
    roles: ['handler', 'admin'],
    requireAssignee: true,
  },
  resume: {
    from: ['PENDING'],
    to: 'IN_PROGRESS',
    roles: ['handler', 'admin'],
    requireAssignee: true,
  },
  resolve: {
    from: ['IN_PROGRESS'],
    to: 'RESOLVED',
    roles: ['handler', 'admin'],
    requireAssignee: true,
  },
  close: {
    from: ['RESOLVED'],
    to: 'CLOSED',
    roles: ['requester', 'supervisor', 'admin'],
    requireRequester: true,
  },
  reopen: {
    from: ['RESOLVED', 'CLOSED'],
    to: 'REOPENED',
    roles: ['requester', 'supervisor', 'admin'],
  },
  cancel: {
    from: ['NEW', 'ASSIGNED'],
    to: 'CANCELLED',
    roles: ['requester', 'admin'],
    requireRequester: true,
  },
};

@Injectable()
export class WorkflowService {
  /** 返回给定状态+用户下可执行的动作（前端渲染按钮用） */
  availableActions(
    status: TicketStatus,
    user: AuthUser,
    ticket: { requesterId: string; assigneeId: string | null },
  ): TicketAction[] {
    return (Object.keys(RULES) as TicketAction[]).filter((action) => {
      try {
        this.assertAllowed(action, status, user, ticket);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** 校验流转是否合法，非法抛 409/403；合法返回目标状态 */
  resolveTransition(
    action: TicketAction,
    status: TicketStatus,
    user: AuthUser,
    ticket: { requesterId: string; assigneeId: string | null },
  ): TicketStatus {
    this.assertAllowed(action, status, user, ticket);
    return RULES[action].to;
  }

  private assertAllowed(
    action: TicketAction,
    status: TicketStatus,
    user: AuthUser,
    ticket: { requesterId: string; assigneeId: string | null },
  ) {
    const rule = RULES[action];
    if (!rule) throw new ConflictException(`未知动作: ${action}`);
    if (!rule.from.includes(status)) {
      throw new ConflictException(
        `当前状态 ${status} 不能执行「${action}」`,
      );
    }
    const isAdmin = user.roles.includes('admin');
    const isSupervisor = user.roles.includes('supervisor');

    if (!rule.roles.some((r) => user.roles.includes(r))) {
      throw new ForbiddenException(`无权执行「${action}」`);
    }
    if (rule.requireAssignee && !isAdmin) {
      if (ticket.assigneeId !== user.id) {
        throw new ForbiddenException('只有该工单的处理人可以操作');
      }
    }
    if (rule.requireRequester && !isAdmin && !isSupervisor) {
      if (ticket.requesterId !== user.id) {
        throw new ForbiddenException('只有提单人可以操作');
      }
    }
  }
}
