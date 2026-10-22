import type { PrismaClient } from '@prisma/client';

/**
 * 正文引用的附件下载地址。编辑器是「先传图、后发消息」：附件上传时还没有
 * messageId，消息落库后用它把附件绑到消息上。
 */
export const ATTACHMENT_URL_RE = /\/attachments\/([A-Za-z0-9_-]+)\/download/g;

export function referencedAttachmentIds(body: string): Set<string> {
  const ids = new Set<string>();
  // matchAll 会从全局正则当前的 lastIndex 开始；显式归零，避免跨调用残留状态。
  ATTACHMENT_URL_RE.lastIndex = 0;
  for (const match of body.matchAll(ATTACHMENT_URL_RE)) ids.add(match[1]);
  return ids;
}

export type AttachmentReferenceSets = {
  /** 被至少一条公开消息引用 */
  publicIds: Set<string>;
  /** 被至少一条内部备注引用 */
  internalIds: Set<string>;
};

type ReferenceReader = Pick<PrismaClient, 'ticketMessage'>;

/**
 * 收集工单内的附件正文引用，并按引用消息的可见性分开。
 *
 * 未绑定消息的历史附件用 internalIds 做「内部优先」判断：只要内部备注引用过，
 * 就不能因为另一条公开正文也引用了它而解禁。绑定消息的附件不走这里，直接以
 * 消息的 isInternal 为准。
 */
export async function loadAttachmentReferences(
  db: ReferenceReader,
  ticketId: string,
): Promise<AttachmentReferenceSets> {
  const messages = await db.ticketMessage.findMany({
    where: { ticketId, body: { contains: '/attachments/' } },
    select: { body: true, isInternal: true },
  });
  const publicIds = new Set<string>();
  const internalIds = new Set<string>();
  for (const message of messages) {
    const target = message.isInternal ? internalIds : publicIds;
    for (const id of referencedAttachmentIds(message.body)) target.add(id);
  }
  return { publicIds, internalIds };
}
