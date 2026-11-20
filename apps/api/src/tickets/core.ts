import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HistoryAction, Prisma, type Ticket, TicketStatus } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { TicketContactDto } from './contact';

/**
 * 工单域的共享常量与纯函数 helper。TicketsService 拆分后，各领域类共用这里
 * 的定义；函数一律显式接收依赖（prisma / tx / notifications），不做隐式状态。
 */

/** 工单没设类型时的兜底时限。类型的 SLA 可由管理员在界面上配置，
 * 这里只是防止「没类型 = 没有任何 SLA 监控」。 */
export const FALLBACK_SLA = { responseMin: 60, resolveMin: 1440 };
export const TERMINAL_STATUSES: TicketStatus[] = ['RESOLVED', 'CLOSED', 'CANCELLED'];
export const COMPLETED_STATUSES: TicketStatus[] = ['RESOLVED', 'CLOSED'];

/** Keep the existing JSON number contract; practical millisecond durations are
 * exact within Number's safe integer range. Never return Prisma BigInt to JSON. */
export function ticketForApi<T extends { holdMs: bigint }>(ticket: T) {
  return { ...ticket, holdMs: Number(ticket.holdMs) };
}

/** 会话流要展示头像和邮箱，凡是返回消息作者的地方都按这套字段取 */
export const AUTHOR_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

export const PARTICIPANT_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

/**
 * 联系方式落库前收敛一次：去掉首尾空格、丢掉空的邮件行。
 * 前端「添加邮件地址」允许留空行，不清掉就会把 "" 存进去。
 */
export function normalizeContact(
  contact?: TicketContactDto | null,
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

export async function allocateTicketNo(
  tx: Pick<Prisma.TransactionClient, 'ticketNumberCounter'>,
  createdAt: Date,
): Promise<string> {
  // Match the container's existing UTC numbering day across all API replicas.
  const day = createdAt.toISOString().slice(0, 10).replaceAll('-', '');
  const { lastValue } = await tx.ticketNumberCounter.upsert({
    where: { day },
    create: { day, lastValue: 1n },
    update: { lastValue: { increment: 1n } },
    select: { lastValue: true },
  });
  return `WO-${day}-${lastValue.toString().padStart(4, '0')}`;
}

export function writeHistory(
  db: Pick<Prisma.TransactionClient, 'ticketHistory'>,
  ticketId: string,
  userId: string,
  action: HistoryAction,
  field?: string,
  oldValue?: string | null,
  newValue?: string | null,
) {
  return db.ticketHistory.create({
    data: { ticketId, userId, action, field, oldValue, newValue },
  });
}

export async function loadTicketOrThrow(
  db: Pick<Prisma.TransactionClient, 'ticket'>,
  id: string,
) {
  const ticket = await db.ticket.findUnique({ where: { id } });
  if (!ticket) throw new NotFoundException('工单不存在');
  return ticket;
}

/**
 * 分类落库：下拉选中的 id 优先；否则拿自填的名字去找已有分类，找不到才新建。
 * 忽略大小写和首尾空格做匹配——不去重的话分类表很快会长出
 *「网络」「网络 」「网络」三条同义项，筛选和报表就没法用了。
 */
export async function resolveCategoryId(
  db: Pick<Prisma.TransactionClient, 'category'>,
  categoryId?: string,
  categoryName?: string,
): Promise<string | undefined> {
  if (categoryId) return categoryId;
  const name = categoryName?.trim();
  if (!name) return undefined;
  const existing = await db.category.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (existing) return existing.id;
  const created = await db.category.create({ data: { name } });
  return created.id;
}

/**
 * 取该类型的 SLA 时限。没设类型时用兜底值——宁可给个保守时限，
 * 也不要让工单彻底脱离 SLA 监控悄悄躺着。
 */
export async function slaOf(
  prisma: Pick<Prisma.TransactionClient, 'ticketType'>,
  typeId: string | null,
) {
  const type = typeId
    ? await prisma.ticketType.findUnique({ where: { id: typeId } })
    : null;
  return {
    responseMin: type?.slaResponseMin ?? FALLBACK_SLA.responseMin,
    resolveMin: type?.slaResolveMin ?? FALLBACK_SLA.resolveMin,
  };
}

export async function ticketParticipantIds(
  db: Pick<Prisma.TransactionClient, 'ticketParticipant'>,
  ticketId: string,
  role?: 'COLLABORATOR' | 'FOLLOWER',
) {
  const participants = await db.ticketParticipant.findMany({
    where: { ticketId, ...(role ? { role } : {}) },
    select: { userId: true },
  });
  return participants.map((participant) => participant.userId);
}

export async function notifyMany(
  notifications: Pick<NotificationsService, 'notify'>,
  ids: string[],
  actorId: string,
  type: string,
  title: string,
  content: string,
  ticketId: string,
) {
  await Promise.all(
    [...new Set(ids)]
      .filter((id) => id !== actorId)
      .map((id) =>
        notifications.notify(id, { type, title, content, ticketId }),
      ),
  );
}

/** 编辑接口的引用字段校验：给出不存在的选项时报 400 并指明字段。 */
export async function assertValidReference(
  field: string,
  value: unknown,
  find: () => Promise<unknown>,
) {
  if (value === undefined || value === null) return;
  if (!value || !(await find())) {
    throw new BadRequestException({
      message: '属性选项不存在',
      code: 'INVALID_REFERENCE',
      field,
    });
  }
}
