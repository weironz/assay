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
import { TicketContactDto } from './contact';

/**
 * 联系方式落库前收敛一次：去掉首尾空格、丢掉空的邮件行。
 * 前端「添加邮件地址」允许留空行，不清掉就会把 "" 存进去。
 */
function normalizeContact(
  contact?: TicketContactDto,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!contact?.phone?.trim()) return Prisma.JsonNull;
  return {
    ...(contact.position ? { position: contact.position } : {}),
    phone: contact.phone.trim(),
    callTime: contact.callTime,
    smsTime: contact.smsTime,
    emails: (contact.emails ?? []).map((e) => e.trim()).filter(Boolean),
  };
}

/**
 * 工单没设类型时的兜底时限。类型的 SLA 可由管理员在界面上配置，
 * 这里只是防止「没类型 = 没有任何 SLA 监控」。
 */
const FALLBACK_SLA = { responseMin: 60, resolveMin: 1440 };

/** 会话流要展示头像和邮箱，凡是返回消息作者的地方都按这套字段取 */
const AUTHOR_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

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
    // 取当天最大编号 +1，而不是数当天条数：删掉任意一张单都会让计数回退，
    // 下一张新单就会撞上已存在的编号。序号补零到 4 位，字典序即数字序。
    const last = await this.prisma.ticket.findFirst({
      where: { ticketNo: { startsWith: prefix } },
      orderBy: { ticketNo: 'desc' },
      select: { ticketNo: true },
    });
    const seq = last ? Number(last.ticketNo.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
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

  /** 独立的数据范围权限：允许读取全部工单，但不自动授予任何写操作。 */
  private canReadAll(user: AuthUser) {
    return user.permissions.includes('ticket:read:all');
  }

  /** 列表数据级可见性：有 ticket:read:all 全看；否则仅自己提交或指派给自己的。 */
  private visibilityFilter(user: AuthUser): Prisma.TicketWhereInput {
    if (this.canReadAll(user)) {
      return {};
    }
    return { OR: [{ requesterId: user.id }, { assigneeId: user.id }] };
  }

  private canView(user: AuthUser, ticket: { requesterId: string; assigneeId: string | null }) {
    if (this.canReadAll(user)) return true;
    return ticket.requesterId === user.id || ticket.assigneeId === user.id;
  }

  /**
   * 写操作仍沿用原有边界：管理员/主管可处理全部工单，其他人只能操作与自己相关的工单。
   * 不把 ticket:read:all 混进这里，避免“全局只读”意外变成全局可编辑。
   */
  private canOperate(user: AuthUser, ticket: { requesterId: string; assigneeId: string | null }) {
    if (user.roles.includes('admin') || user.roles.includes('supervisor')) return true;
    return ticket.requesterId === user.id || ticket.assigneeId === user.id;
  }

  /**
   * 分类落库：下拉选中的 id 优先；否则拿自填的名字去找已有分类，找不到才新建。
   * 忽略大小写和首尾空格做匹配——不去重的话分类表很快会长出
   *「网络」「网络 」「网络」三条同义项，筛选和报表就没法用了。
   */
  private async resolveCategoryId(
    categoryId?: string,
    categoryName?: string,
  ): Promise<string | undefined> {
    if (categoryId) return categoryId;
    const name = categoryName?.trim();
    if (!name) return undefined;
    const existing = await this.prisma.category.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) return existing.id;
    const created = await this.prisma.category.create({ data: { name } });
    return created.id;
  }

  /**
   * 编号是「读当天最大值 + 1」，两个请求挨得足够近就会读到同一个值。
   * 唯一索引会挡住后一个，这里重取编号再试；连撞 5 次就不是并发问题了，抛出去。
   */
  private async createWithTicketNo(
    build: (ticketNo: string) => Prisma.TicketCreateArgs,
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.ticket.create(build(await this.genTicketNo()));
      } catch (e) {
        const dup =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          String(e.meta?.target ?? '').includes('ticket_no');
        if (!dup || attempt === 4) throw e;
      }
    }
    throw new Error('unreachable');
  }

  /**
   * 取该类型的 SLA 时限。没设类型时用兜底值——宁可给个保守时限，
   * 也不要让工单彻底脱离 SLA 监控悄悄躺着。
   */
  private async slaOf(typeId: string | null) {
    const type = typeId
      ? await this.prisma.ticketType.findUnique({ where: { id: typeId } })
      : null;
    return {
      responseMin: type?.slaResponseMin ?? FALLBACK_SLA.responseMin,
      resolveMin: type?.slaResolveMin ?? FALLBACK_SLA.resolveMin,
    };
  }

  // ---------- 建单 ----------
  async create(user: AuthUser, dto: CreateTicketDto) {
    const categoryId = await this.resolveCategoryId(
      dto.categoryId,
      dto.categoryName,
    );
    const ticket = await this.createWithTicketNo((ticketNo) => ({
      data: {
        ticketNo,
        title: dto.title,
        requesterId: user.id,
        priority: (dto.priority as any) ?? 'MEDIUM',
        typeId: dto.typeId,
        categoryId,
        queueId: dto.queueId,
        datacenterId: dto.datacenterId,
        clusterId: dto.clusterId,
        serialNumber: dto.serialNumber?.trim() || null,
        contact: normalizeContact(dto.contact),
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
    }));
    // SLA 从建单起算：一直没人接手才是最该告警的情况，
    // 从「开始处理」起算的话这种单永远不会超时
    const sla = await this.slaOf(dto.typeId ?? null);
    const base = ticket.createdAt.getTime();
    const firstResponseDueAt = new Date(base + sla.responseMin * 60_000);
    const slaDueAt = new Date(base + sla.resolveMin * 60_000);
    await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { firstResponseDueAt, slaDueAt },
    });
    await this.sla.schedule(ticket.id, 'response', firstResponseDueAt);
    await this.sla.schedule(ticket.id, 'resolve', slaDueAt);

    await this.history(ticket.id, user.id, 'CREATE', 'status', null, 'NEW');
    // 勾了「设为默认」才写用户档案；没勾就不动，免得覆盖上次存好的
    if (dto.saveContactAsDefault && dto.contact?.phone?.trim()) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { defaultContact: normalizeContact(dto.contact) },
      });
    }
    // 关联建单前上传的草稿附件（仅本人、仍未挂单的）
    if (dto.attachmentIds?.length) {
      await this.prisma.ticketAttachment.updateMany({
        where: {
          id: { in: dto.attachmentIds },
          uploaderId: user.id,
          ticketId: null,
        },
        data: { ticketId: ticket.id },
      });
    }
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
        datacenter: true,
        cluster: true,
        tags: { include: { tag: true } },
        messages: {
          include: { author: { select: AUTHOR_SELECT } },
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
    if (!this.canOperate(user, ticket)) throw new ForbiddenException('无权操作');
    const updated = await this.prisma.ticket.update({
      where: { id },
      data: {
        title: dto.title,
        priority: dto.priority as any,
        typeId: dto.typeId,
        categoryId: dto.categoryId,
        queueId: dto.queueId,
        datacenterId: dto.datacenterId,
        clusterId: dto.clusterId,
        serialNumber:
          dto.serialNumber === undefined
            ? undefined
            : dto.serialNumber.trim() || null,
        // 清空联系方式要能落库，所以显式区分「没传」和「传了空值」
        contact: dto.contact === undefined ? undefined : normalizeContact(dto.contact),
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
    const now = new Date();
    // 计时起点在建单，这里只负责「暂停/恢复/重开」三种对时钟的影响
    let responseDue = ticket.firstResponseDueAt;
    let resolveDue = ticket.slaDueAt;
    let reschedule = false;

    if (to === 'PENDING') {
      // 挂起：记下暂停起点，把两个到期任务撤掉，时钟就停了
      data.holdStartedAt = now;
      await this.sla.cancel(id);
    } else if (ticket.status === 'PENDING' && ticket.holdStartedAt) {
      // 恢复：把这段暂停时长整体加回到两个截止时刻上，等价于时钟从未走过
      const paused = now.getTime() - ticket.holdStartedAt.getTime();
      data.holdStartedAt = null;
      data.holdMs = { increment: paused };
      if (responseDue && !ticket.firstResponseAt) {
        responseDue = new Date(responseDue.getTime() + paused);
        data.firstResponseDueAt = responseDue;
      }
      if (resolveDue) {
        resolveDue = new Date(resolveDue.getTime() + paused);
        data.slaDueAt = resolveDue;
      }
      reschedule = true;
    } else if (to === 'REOPENED') {
      // 重开：旧的解决时限早就过期了，继续用它等于永远超时。按类型重新给一档
      const sla = await this.slaOf(ticket.typeId);
      resolveDue = new Date(now.getTime() + sla.resolveMin * 60_000);
      data.slaDueAt = resolveDue;
      reschedule = true;
    }

    if (to === 'CLOSED') data.closedAt = now;

    await this.prisma.ticket.update({ where: { id }, data });
    await this.history(id, user.id, 'TRANSITION', 'status', ticket.status, to);

    // SLA 任务调度 / 取消
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(to)) {
      await this.sla.cancel(id);
    } else if (reschedule) {
      if (!ticket.firstResponseAt) {
        await this.sla.schedule(id, 'response', responseDue);
      }
      await this.sla.schedule(id, 'resolve', resolveDue);
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
    if (!this.canOperate(user, ticket)) throw new ForbiddenException('无权回复');

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
      include: { author: { select: AUTHOR_SELECT } },
    });
    await this.history(id, user.id, 'MESSAGE', 'message', null, isInternal ? '内部备注' : '回复');

    // 首次由非提单人发出的公开回复 → 记 first_response，并撤掉响应超时任务
    if (!ticket.firstResponseAt && !isInternal && ticket.requesterId !== user.id) {
      await this.prisma.ticket.update({
        where: { id },
        data: { firstResponseAt: new Date() },
      });
      await this.sla.cancel(id, 'response');
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
      include: { author: { select: AUTHOR_SELECT } },
    });
    await this.history(ticketId, user.id, 'UPDATE', 'message', null, '编辑消息');
    return updated;
  }

  // ---------- 删除（管理员 / 提单人本人）----------
  async remove(user: AuthUser, id: string) {
    const ticket = await this.loadOrThrow(id);
    // 提单人可以撤掉自己提的单；别人的单只有管理员能删
    if (!user.roles.includes('admin') && ticket.requesterId !== user.id) {
      throw new ForbiddenException('只能删除自己提交的工单');
    }
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
