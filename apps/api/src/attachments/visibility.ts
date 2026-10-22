import type { PrismaClient } from '@prisma/client';

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

type ReferenceReader = Pick<PrismaClient, 'ticketMessage'>;

/**
 * 公开正文是否实际引用了该附件。
 *
 * 分享页只放行「已绑定公开消息」且「确实出现在公开正文里」的附件。这里显式
 * 限定 isInternal=false，内部备注里的引用永远不能给外部链接放行；找不到引用
 * 就不分享，避免绑定到公开消息但从正文移除的附件继续通过旧地址下载。
 */
export async function isReferencedByPublicMessage(
  db: ReferenceReader,
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
