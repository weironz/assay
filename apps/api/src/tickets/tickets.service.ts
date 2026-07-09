import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HistoryAction, Prisma, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { WorkflowService, TicketAction } from './workflow.service';
import { cleanHtml } from '../common/sanitize';
import { NotificationsService } from '../notifications/notifications.service';
import { SlaService } from '../sla/sla.service';
import {
  AssignDto,
  CreateMessageDto,
  CreateTicketDto,
  ListTicketsQuery,
  UpdateTicketDto,
} from './dto';

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowService,
    private readonly notifications: NotificationsService,
    private readonly sla: SlaService,
  ) {}

  // ---------- 工具 ----------
  private async genTicketNo(): Promise<string> {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    const prefix = `WO-${ymd}-`;
    const countToday = await this.prisma.ticket.count({
      where: { ticketNo: { startsWith: prefix } },
    });
    return `${prefix}${String(countToday + 1).padStart(4, '0')}`;
  }

  private history(
    ticketId: string,
    userId: string,
    action: HistoryAction,
    field?: string,
    oldValue?: string | null,
    newValue?: string | null,
  ) {
    return this.prisma.ticketHistory.create({
      data: { ticketId, userId, action, field, oldValue, newValue },
    });
  }

  private async loadOrThrow(id: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('工单不存在');
    return ticket;
  }

  /** 列表数据级可见性：admin/supervisor 全看；否则只看自己提交或指派给自己的 */
  private visibilityFilter(user: AuthUser): Prisma.TicketWhereInput {
    if (user.roles.includes('admin') || user.roles.includes('supervisor')) {
      return {};
    }
    return { OR: [{ requesterId: user.id }, { assigneeId: user.id }] };
  }

  private canView(user: AuthUser, ticket: { requesterId: string; assigneeId: string | null }) {
    if (user.roles.includes('admin') || user.roles.includes('supervisor')) return true;
    return ticket.requesterId === user.id || ticket.assigneeId === user.id;
  }

  // ---------- 建单 ----------
  async create(user: AuthUser, dto: CreateTicketDto) {
    const ticketNo = await this.genTicketNo();
    const ticket = await this.prisma.ticket.create({
      data: {
        ticketNo,
        title: dto.title,
        requesterId: user.id,
        priority: (dto.priority as any) ?? 'MEDIUM',
        typeId: dto.typeId,
        categoryId: dto.categoryId,
        queueId: dto.queueId,
        status: 'NEW',
        messages: {
          create: {
            authorId: user.id,
            type: 'REPLY',
            isInternal: false,
            contentType: 'text/html',
            body: cleanHtml(dto.body),
          },
        },
      },
    });
    await this.history(ticket.id, user.id, 'CREATE', 'status', null, 'NEW');
    return this.findOne(user, ticket.id);
  }

  // ---------- 列表 ----------
  async list(user: AuthUser, q: ListTicketsQuery) {
    const where: Prisma.TicketWhereInput = { ...this.visibilityFilter(user) };
    if (q.status) where.status = q.status as TicketStatus;
    if (q.priority) where.priority = q.priority as any;
    if (q.queueId) where.queueId = q.queueId;
    if (q.assigneeId) where.assigneeId = q.assigneeId;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.keyword) {
      where.OR = [
        { title: { contains: q.keyword, mode: 'insensitive' } },
        { ticketNo: { contains: q.keyword, mode: 'insensitive' } },
      ];
    }

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
        },
        orderBy: { [q.sort ?? 'createdAt']: q.order ?? 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  // ---------- 详情 ----------
  async findOne(user: AuthUser, id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        requester: { select: { id: true, name: true, email: true } },
        assignee: { select: { id: true, name: true } },
        queue: true,
        type: true,
        category: true,
        tags: { include: { tag: true } },
        messages: {
          include: { author: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (!this.canView(user, ticket)) throw new ForbiddenException('无权查看该工单');

    // 提单人看不到内部备注
    const isStaff =
      user.roles.includes('admin') ||
      user.roles.includes('supervisor') ||
      ticket.assigneeId === user.id;
    const messages = isStaff
      ? ticket.messages
      : ticket.messages.filter((m) => !m.isInternal);

    const actions = this.workflow.availableActions(ticket.status, user, ticket);
    return { ...ticket, messages, availableActions: actions };
  }

  // ---------- 编辑 ----------
  async update(user: AuthUser, id: string, dto: UpdateTicketDto) {
    const ticket = await this.loadOrThrow(id);
    if (!this.canView(user, ticket)) throw new ForbiddenException('无权操作');
    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        title: dto.title,
        priority: dto.priority as any,
        typeId: dto.typeId,
        categoryId: dto.categoryId,
        queueId: dto.queueId,
      },
    });
    await this.history(id, user.id, 'UPDATE', 'fields', null, JSON.stringify(dto));
    return this.findOne(user, updated.id);
  }

  // ---------- 指派 ----------
  async assign(user: AuthUser, id: string, dto: AssignDto) {
    const ticket = await this.loadOrThrow(id);
    if (!['NEW', 'REOPENED'].includes(ticket.status)) {
      throw new BadRequestException(`当前状态 ${ticket.status} 不可指派`);
    }
    const assignee = await this.prisma.user.findUnique({
      where: { id: dto.assigneeId },
    });
    if (!assignee) throw new BadRequestException('指派对象不存在');

    await this.prisma.ticket.update({
      where: { id },
      data: {
        assigneeId: dto.assigneeId,
        queueId: dto.queueId ?? ticket.queueId,
        status: 'ASSIGNED',
      },
    });
    await this.history(
      id,
      user.id,
      'ASSIGN',
      'assignee',
      ticket.assigneeId,
      dto.assigneeId,
    );
    await this.history(id, user.id, 'TRANSITION', 'status', ticket.status, 'ASSIGNED');
    await this.notifications.notify(dto.assigneeId, {
      type: 'ASSIGNED',
      title: `你被指派了工单：${ticket.ticketNo}`,
      content: ticket.title,
      ticketId: id,
    });
    return this.findOne(user, id);
  }

  // ---------- 状态流转 ----------
  async transition(user: AuthUser, id: string, action: TicketAction) {
    const ticket = await this.loadOrThrow(id);
    const to = this.workflow.resolveTransition(action, ticket.status, user, ticket);

    const data: Prisma.TicketUpdateInput = { status: to };
    let slaDueAt: Date | null = null;
    // 进入处理中：按类型 SLA 计算解决时限
    if (to === 'IN_PROGRESS') {
      const type = ticket.typeId
        ? await this.prisma.ticketType.findUnique({ where: { id: ticket.typeId } })
        : null;
      const mins = type?.slaResolveMin ?? 1440;
      slaDueAt = new Date(Date.now() + mins * 60_000);
      data.slaDueAt = slaDueAt;
    }
    if (to === 'CLOSED') data.closedAt = new Date();

    await this.prisma.ticket.update({ where: { id }, data });
    await this.history(id, user.id, 'TRANSITION', 'status', ticket.status, to);

    // SLA 任务调度 / 取消
    if (to === 'IN_PROGRESS' && slaDueAt) {
      await this.sla.schedule(id, slaDueAt);
    } else if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(to)) {
      await this.sla.cancel(id);
    }

    // 状态变更通知
    await this.notifyTransition(user, ticket, to);
    return this.findOne(user, id);
  }

  private async notifyTransition(
    user: AuthUser,
    ticket: { id: string; ticketNo: string; title: string; requesterId: string; assigneeId: string | null },
    to: TicketStatus,
  ) {
    const base = { ticketId: ticket.id, content: ticket.title };
    const notify = (uid: string | null, type: string, title: string) =>
      uid && uid !== user.id
        ? this.notifications.notify(uid, { type, title, ...base })
        : undefined;

    if (to === 'RESOLVED') {
      await notify(ticket.requesterId, 'RESOLVED', `工单已处理待验收：${ticket.ticketNo}`);
    } else if (to === 'CLOSED') {
      await notify(ticket.assigneeId, 'CLOSED', `工单已关闭：${ticket.ticketNo}`);
    } else if (to === 'REOPENED') {
      await notify(ticket.assigneeId, 'REOPENED', `工单被重新打开：${ticket.ticketNo}`);
    } else if (to === 'CANCELLED') {
      await notify(ticket.assigneeId, 'CANCELLED', `工单被取消：${ticket.ticketNo}`);
    }
  }

  // ---------- 消息 ----------
  async addMessage(user: AuthUser, id: string, dto: CreateMessageDto) {
    const ticket = await this.loadOrThrow(id);
    if (!this.canView(user, ticket)) throw new ForbiddenException('无权回复');

    const isStaff =
      user.roles.includes('admin') ||
      user.roles.includes('supervisor') ||
      user.roles.includes('handler');
    const isInternal = !!dto.isInternal && isStaff; // 仅内部人员可发内部备注

    const message = await this.prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorId: user.id,
        type: isInternal ? 'NOTE' : 'REPLY',
        isInternal,
        contentType: dto.contentType ?? 'text/html',
        body: cleanHtml(dto.body),
      },
      include: { author: { select: { id: true, name: true } } },
    });
    await this.history(id, user.id, 'MESSAGE', 'message', null, isInternal ? '内部备注' : '回复');

    // 首次由非提单人发出的公开回复 → 记 first_response
    if (!ticket.firstResponseAt && !isInternal && ticket.requesterId !== user.id) {
      await this.prisma.ticket.update({
        where: { id },
        data: { firstResponseAt: new Date() },
      });
    }

    // 通知对方
    const notifyTarget = async (uid: string | null) => {
      if (uid && uid !== user.id) {
        await this.notifications.notify(uid, {
          type: 'MESSAGE',
          title: `工单有新回复：${ticket.ticketNo}`,
          content: ticket.title,
          ticketId: id,
        });
      }
    };
    if (isInternal) {
      await notifyTarget(ticket.assigneeId); // 内部备注仅通知处理人
    } else if (ticket.requesterId === user.id) {
      await notifyTarget(ticket.assigneeId); // 提单人回复 → 通知处理人
    } else {
      await notifyTarget(ticket.requesterId); // 处理人回复 → 通知提单人
    }
    return message;
  }

  // ---------- 编辑消息（作者本人或 admin/supervisor）----------
  async updateMessage(
    user: AuthUser,
    ticketId: string,
    messageId: string,
    dto: CreateMessageDto,
  ) {
    const msg = await this.prisma.ticketMessage.findUnique({
      where: { id: messageId },
    });
    if (!msg || msg.ticketId !== ticketId) {
      throw new NotFoundException('消息不存在');
    }
    const isStaff =
      user.roles.includes('admin') || user.roles.includes('supervisor');
    if (msg.authorId !== user.id && !isStaff) {
      throw new ForbiddenException('只能编辑自己的消息');
    }
    const updated = await this.prisma.ticketMessage.update({
      where: { id: messageId },
      data: { body: cleanHtml(dto.body) },
      include: { author: { select: { id: true, name: true } } },
    });
    await this.history(ticketId, user.id, 'UPDATE', 'message', null, '编辑消息');
    return updated;
  }

  // ---------- 删除（仅管理员）----------
  async remove(user: AuthUser, id: string) {
    if (!user.roles.includes('admin')) {
      throw new ForbiddenException('仅管理员可删除工单');
    }
    await this.loadOrThrow(id);
    await this.sla.cancel(id);
    // 级联删除消息/历史/附件记录/标签（附件对象暂留存储，可后续清理）
    await this.prisma.ticket.delete({ where: { id } });
    return { ok: true };
  }

  async history_(user: AuthUser, id: string) {
    const ticket = await this.loadOrThrow(id);
    if (!this.canView(user, ticket)) throw new ForbiddenException('无权查看');
    return this.prisma.ticketHistory.findMany({
      where: { ticketId: id },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
