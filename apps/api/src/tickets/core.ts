import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HistoryAction, Prisma, TicketStatus } from '@prisma/client';
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

export async function genTicketNo(
  prisma: Pick<Prisma.TransactionClient, 'ticket'>,
): Promise<string> {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  const prefix = `WO-${ymd}-`;
  // 取当天最大编号 +1，而不是数当天条数：删掉任意一张单都会让计数回退，
  // 下一张新单就会撞上已存在的编号。序号补零到 4 位，字典序即数字序。
  const last = await prisma.ticket.findFirst({
    where: { ticketNo: { startsWith: prefix } },
    orderBy: { ticketNo: 'desc' },
    select: { ticketNo: true },
  });
  const seq = last ? Number(last.ticketNo.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
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
 * 编号是「读当天最大值 + 1」，两个请求挨得足够近就会读到同一个值。
 * 唯一索引会挡住后一个，这里重取编号再试；连撞 5 次就不是并发问题了，抛出去。
 */
export async function createWithTicketNo(
  prisma: Pick<Prisma.TransactionClient, 'ticket'>,
  build: (ticketNo: string) => Prisma.TicketCreateArgs,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.ticket.create(build(await genTicketNo(prisma)));
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
