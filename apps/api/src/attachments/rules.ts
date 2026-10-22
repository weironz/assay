import type { Prisma, PrismaClient } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import {
  canOperateTicket,
  isInternalParticipant,
  isTicketCollaborator,
  TicketRoleAccess,
} from '../tickets/visibility';

/**
 * 附件规则的唯一定义：可见性、绑定、分享放行都只在这里。
 *
 * 曾经这套规则散在三个模块：「列表/下载判定」内联在附件服务、「消息落库时
 * 绑定正文引用」放在工单服务、分享页又自建一套「绑定优先、公开引用放行」，
 * 同一处口径要改 2-3 个地方。任何改动只许在这里发生，调用点一律 import。
 *
 * 工单级判定（谁能看单、谁是内部参与方、谁能操作）复用 tickets/visibility
 * 的地基，这里只做「附件」这一层的组合，不复制地基的规则。
 */

type MessageReader = Pick<PrismaClient, 'ticketMessage'>;

// ——— 正文引用：URL 解析与改写 ———

/**
 * 正文引用的附件下载地址。编辑器是「先传图、后发消息」：附件上传时还没有
 * messageId，消息落库后用它把附件绑到消息上。
 *
 * 历史正文里同时存在四种形式：带源站的绝对地址、/api 前缀、相对路径、
 * 尾挂查询串（如 ?w=100），解析与改写都必须认领同一管网正则，
 * 否则会出现「站内可见、分享页 404」的口径分裂。
 */
export const ATTACHMENT_URL_RE =
  /(?:https?:\/\/[^"'<>\s]+)?(?:\/api)?\/attachments\/([A-Za-z0-9_-]+)\/download/g;

export function matchAttachmentUrl(body: string): string[] {
  // matchAll 会从全局正则当前的 lastIndex 开始；显式归零，避免跨调用残留状态。
  ATTACHMENT_URL_RE.lastIndex = 0;
  return Array.from(body.matchAll(ATTACHMENT_URL_RE), (match) => match[1]);
}

export function referencedAttachmentIds(body: string): Set<string> {
  return new Set(matchAttachmentUrl(body));
}

/** 把正文里的每个附件下载地址交给 mapper 改写（mapper 收附件 ID、返回新地址） */
export function rewriteAttachmentUrls(
  body: string,
  mapper: (attachmentId: string) => string,
): string {
  ATTACHMENT_URL_RE.lastIndex = 0;
  return body.replace(ATTACHMENT_URL_RE, (_match, attachmentId: string) =>
    mapper(attachmentId),
  );
}

/** 公开正文是否实际引用了该附件。 */
export async function isReferencedByPublicMessage(
  db: MessageReader,
  ticketId: string,
  attachmentId: string,
): Promise<boolean> {
  const message = await db.ticketMessage.findFirst({
    where: {
      ticketId,
      isInternal: false,
      // 正文可能带源站、/api 前缀或查询串，但 /attachments/<id>/download 这段
      // 在四种历史形式里都保持不变。
      body: { contains: `/attachments/${attachmentId}/download` },
    },
    select: { id: true },
  });
  return !!message;
}

// ——— 绑定 ———

/**
 * 编辑器是「先传图、后发消息」：附件上传时还没有 messageId，消息落库后
 * 才能判断它属于公开回复还是内部备注。这里按正文引用把本人尚未归属消息
 * 的附件绑定到新消息，附件可见性就能直接复用消息的 isInternal。
 *
 * 必须与消息写入共用同一个事务：否则消息已提交、绑定尚未提交的窗口里，
 * 正文里的图片仍处于未绑定状态，非上传者/内部成员会看不到它；绑定与消息
 * 一起提交后，可见性直接由消息的 isInternal 决定。
 */
export async function linkReferencedAttachments(
  db: Prisma.TransactionClient,
  ticketId: string,
  messageId: string,
  body: string,
  uploaderId: string,
) {
  const ids = [...referencedAttachmentIds(body)];
  if (!ids.length) return;
  // 旧流程可能先按草稿上传（ticketId 为空）再把图片粘进回复；这里先把本人
  // 仍处于草稿状态的引用附件挂到当前工单，下一句才能绑定 messageId。
  await db.ticketAttachment.updateMany({
    where: { id: { in: ids }, uploaderId, ticketId: null, messageId: null },
    data: { ticketId },
  });
  await db.ticketAttachment.updateMany({
    where: { id: { in: ids }, ticketId, uploaderId, messageId: null },
    data: { messageId },
  });
}

/** 谁能向工单上传附件：可操作工单的人（管理岗/提单人/处理人）或协作成员。 */
export function canUploadToTicket(
  user: AuthUser,
  ticket: TicketRoleAccess,
): boolean {
  return canOperateTicket(user, ticket) || isTicketCollaborator(user, ticket);
}

export type MessageBindingIssue = 'FOREIGN_MESSAGE' | 'INTERNAL_MESSAGE';

/**
 * 上传时校验附件将绑定的消息：必须属于当前工单；内部备注只放行内部参与方，
 * 内部参与方判定复用 tickets/visibility，附件域不再自建一份。
 */
export async function messageBindingIssue(
  db: MessageReader,
  user: AuthUser,
  ticket: TicketRoleAccess,
  ticketId: string,
  messageId: string,
): Promise<MessageBindingIssue | null> {
  const message = await db.ticketMessage.findFirst({
    where: { id: messageId, ticketId },
    select: { isInternal: true },
  });
  if (!message) return 'FOREIGN_MESSAGE';
  if (message.isInternal && !isInternalParticipant(user, ticket)) {
    return 'INTERNAL_MESSAGE';
  }
  return null;
}

// ——— 可见性 ———

/**
 * 未绑定消息的附件对非内部成员是否可见。
 *
 * 编辑器是「先传图、再发消息」：图片上传时 messageId 还是空的，消息落库后才
 * 由 linkReferencedAttachments 绑定。这个窗口期只有上传者本人能看自己的草稿
 * 图；历史数据里的正文引用已在迁移中回填 messageId，不再用「公开正文引用过」
 * 作为放行条件——否则猜到附件 ID 的人就能绕过消息可见性。内部参与方不经过
 * 这里，直接按工单可见性放行。
 */
export function isUnboundVisible(
  attachment: { uploaderId: string },
  user: AuthUser,
): boolean {
  return attachment.uploaderId === user.id;
}

/** 列表查询的 where：内部参与方看全部，其他人只看公开消息绑定 + 本人草稿。 */
export function attachmentListWhere(
  user: AuthUser,
  ticket: TicketRoleAccess,
  ticketId: string,
): Prisma.TicketAttachmentWhereInput {
  if (isInternalParticipant(user, ticket)) return { ticketId };
  return {
    ticketId,
    // 非内部成员：已绑定消息的按消息可见性取；未绑定的只返回自己上传的草稿。
    OR: [
      {
        messageId: { not: null },
        message: { isInternal: false, ticketId },
      },
      { messageId: null, uploaderId: user.id },
    ],
  };
}

/** 列表内存兜底过滤，与 attachmentListWhere 同一口径。 */
export function attachmentRowVisible(
  user: AuthUser,
  ticket: TicketRoleAccess,
  row: {
    messageId: string | null;
    uploaderId: string;
    message?: { isInternal: boolean } | null;
  },
): boolean {
  if (isInternalParticipant(user, ticket)) return true;
  if (row.messageId === null) return isUnboundVisible(row, user);
  return row.message?.isInternal === false;
}

/**
 * 挂单附件的下载放行（工单可见性由调用方先行校验）。
 *
 * 内部参与方直接放行；其他人：已绑定消息的跟随消息可见性，未绑定的仅上传者
 * 本人。消息缺失（脏数据）同样按内部材料处理，避免默认放行。
 */
export async function isAttachmentDownloadable(
  db: MessageReader,
  user: AuthUser,
  ticket: TicketRoleAccess,
  rec: { ticketId: string | null; messageId: string | null; uploaderId: string },
): Promise<boolean> {
  if (isInternalParticipant(user, ticket)) return true;
  if (rec.messageId === null) return isUnboundVisible(rec, user);
  // 走到这里说明消息已绑定；绑定的附件必然挂靠工单（迁移保证），空值属于异常数据。
  if (rec.ticketId === null) return false;
  return boundMessageIsPublic(db, rec.ticketId, rec.messageId);
}

async function boundMessageIsPublic(
  db: MessageReader,
  ticketId: string,
  messageId: string,
): Promise<boolean> {
  const message = await db.ticketMessage.findFirst({
    where: { id: messageId, ticketId },
    select: { isInternal: true },
  });
  // 消息不存在（脏数据）同样按内部材料处理，避免默认放行。
  return message?.isInternal === false;
}

// ——— 分享放行 ———

/**
 * 分享页只放行「已绑定公开消息」且「确实出现在公开正文里」的附件。
 *
 * 绑定关系优先于正文引用：内部备注的附件即使被某条公开回复引用了下载地址，
 * 也不能通过分享链接解禁；未绑定消息的附件（含历史数据里没回填的）一律
 * 不对外分享。与站内下载共用 boundMessageIsPublic / isUnboundVisible 的口径，
 * 避免「站内可见、分享页 404」或相反的分裂。
 */
export async function isSharableInlineAttachment(
  db: MessageReader,
  ticketId: string,
  attachment: { id: string; messageId: string | null },
): Promise<boolean> {
  // 查询方已限定 messageId 非空，这里再兜一层，避免将来改查询时把草稿图放出去。
  if (!attachment.messageId) return false;
  if (!(await boundMessageIsPublic(db, ticketId, attachment.messageId))) {
    return false;
  }
  // 绑定到公开消息但已从正文移除的附件不应继续通过旧链接下载；该查询显式
  // 排除内部备注。
  return isReferencedByPublicMessage(db, ticketId, attachment.id);
}
