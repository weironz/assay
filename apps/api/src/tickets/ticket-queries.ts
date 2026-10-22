import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { WorkflowService } from './workflow.service';
import {
  AUTHOR_SELECT,
  COMPLETED_STATUSES,
  PARTICIPANT_USER_SELECT,
  TERMINAL_STATUSES,
} from './core';
import {
  canViewTicket,
  isInternalParticipant,
  ticketVisibilityWhere,
} from './visibility';
import { ListTicketsQuery } from './dto';

/**
 * 工单读取域：列表、筛选人员、详情、审计历史。
 * 注册为 TicketsModule provider，由 TicketsService 构造器注入并委派。
 */
@Injectable()
export class TicketQueries {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * 仅返回当前用户可见工单涉及的人员，供列表的处理人/提单人下拉框使用。
   * 不返回邮箱、角色等目录信息，也不会绕过可见范围。
   */
  async filterPeople(user: AuthUser) {
    const visibleTickets = ticketVisibilityWhere(user);
    return this.prisma.user.findMany({
      where: {
        OR: [
          { requestedTickets: { some: visibleTickets } },
          { assignedTickets: { some: visibleTickets } },
        ],
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async list(user: AuthUser, q: ListTicketsQuery) {
    // 所有筛选都必须与可见范围相交。用 AND 组合可避免关键字/快捷范围覆盖
    // visibilityFilter 里的 OR，从而意外扩大普通用户能看到的工单。
    const filters: Prisma.TicketWhereInput[] = [ticketVisibilityWhere(user)];
    if (q.status) filters.push({ status: q.status as TicketStatus });
    if (q.priority) filters.push({ priority: q.priority as any });
    if (q.queueId) filters.push({ queueId: q.queueId });
    if (q.assigneeId) filters.push({ assigneeId: q.assigneeId === '__none__' ? null : q.assigneeId });
    if (q.datacenterId) filters.push({ datacenterId: q.datacenterId === '__none__' ? null : q.datacenterId });
    if (q.createdFrom && q.createdTo && new Date(q.createdFrom) >= new Date(q.createdTo)) {
      throw new BadRequestException('创建日期范围无效');
    }
    if (q.createdFrom || q.createdTo) filters.push({ createdAt: {
      ...(q.createdFrom ? { gte: new Date(q.createdFrom) } : {}),
      ...(q.createdTo ? { lt: new Date(q.createdTo) } : {}),
    } });
    const activeStates = { notIn: [...TERMINAL_STATUSES, 'PENDING' as TicketStatus] };
    if (q.slaState === 'overdue') filters.push({ status: activeStates, slaDueAt: { lt: new Date() } });
    if (q.slaState === 'within') filters.push({ status: activeStates, slaDueAt: { gte: new Date() } });
    if (q.slaState === 'paused') filters.push({ status: 'PENDING', slaDueAt: { not: null } });
    if (q.slaState === 'completed') filters.push({ status: { in: TERMINAL_STATUSES } });
    if (q.slaState === 'unset') filters.push({ slaDueAt: null, status: { notIn: TERMINAL_STATUSES } });
    if (q.requesterId) filters.push({ requesterId: q.requesterId });
    if (q.categoryId) filters.push({ categoryId: q.categoryId });
    if (q.ticketNo) {
      filters.push({ ticketNo: { contains: q.ticketNo, mode: 'insensitive' } });
    }

    if (q.scope === 'open') {
      filters.push({ status: { notIn: TERMINAL_STATUSES } });
    } else if (q.scope === 'completed') {
      // “已完成”不包含已取消，需与仪表盘口径保持一致。
      filters.push({ status: { in: COMPLETED_STATUSES } });
    } else if (q.scope === 'mine') {
      filters.push({ assigneeId: user.id, status: { notIn: TERMINAL_STATUSES } });
    } else if (q.scope === 'unassigned') {
      filters.push({ assigneeId: null, status: { notIn: TERMINAL_STATUSES } });
    } else if (q.scope === 'overdue') {
      filters.push({
        slaDueAt: { lt: new Date() },
        status: { notIn: [...TERMINAL_STATUSES, 'PENDING'] },
      });
    }

    if (q.keyword) {
      filters.push({
        OR: [
          { title: { contains: q.keyword, mode: 'insensitive' } },
          { ticketNo: { contains: q.keyword, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.TicketWhereInput =
      filters.length === 1 ? filters[0] : { AND: filters };

    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: {
          requester: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
          queue: { select: { id: true, name: true } },
          type: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          datacenter: { select: { id: true, name: true } },
        },
        orderBy: { [q.sort ?? 'createdAt']: q.order ?? 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async findOne(user: AuthUser, id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        requester: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true } },
        queue: true,
        type: true,
        category: true,
        datacenter: true,
        cluster: true,
        tags: { include: { tag: true } },
        participants: {
          include: { user: { select: PARTICIPANT_USER_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
        messages: {
          include: {
            author: { select: AUTHOR_SELECT },
            mentions: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (!canViewTicket(user, ticket)) throw new ForbiddenException('无权查看该工单');

    // 提单人看不到内部备注
    const isStaff = isInternalParticipant(user, ticket);
    const messages = isStaff
      ? ticket.messages
      : ticket.messages.filter((m) => !m.isInternal);

    const actions = this.workflow.availableActions(ticket.status, user, ticket);
    return { ...ticket, messages, availableActions: actions };
  }

  async history(id: string) {
    return this.prisma.ticketHistory.findMany({
      where: { ticketId: id },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
