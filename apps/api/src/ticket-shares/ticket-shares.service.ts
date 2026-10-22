import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';
import { AuthUser } from '../auth/auth.types';
import { isRasterImageMime } from '../attachments/limits';
import {
  isReferencedByPublicMessage,
  rewriteAttachmentUrls,
} from '../attachments/visibility';
import { CreateTicketShareDto } from './ticket-shares.dto';

type ActiveShare = {
  id: string;
  ticketId: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

@Injectable()
export class TicketSharesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  /**
   * 分享会把公开讨论交给持有链接的人，不能因为“被关注”或“全局只读”而间接扩权。
   * 只允许提单人、当前处理人或管理岗位创建/撤销。
   */
  private canManage(user: AuthUser, ticket: { requesterId: string; assigneeId: string | null }) {
    return (
      user.roles.includes('admin') ||
      user.roles.includes('supervisor') ||
      ticket.requesterId === user.id ||
      ticket.assigneeId === user.id
    );
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private status(share: { revokedAt: Date | null; expiresAt: Date | null }) {
    if (share.revokedAt) return 'REVOKED';
    if (share.expiresAt && share.expiresAt <= new Date()) return 'EXPIRED';
    return 'ACTIVE';
  }

  private serialize(share: {
    id: string;
    label: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    return { ...share, status: this.status(share) };
  }

  async list(user: AuthUser, ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { requesterId: true, assigneeId: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (!this.canManage(user, ticket)) throw new ForbiddenException('无权管理工单分享链接');

    const shares = await this.prisma.ticketShare.findMany({
      where: { ticketId },
      select: { id: true, label: true, expiresAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return shares.map((share) => this.serialize(share));
  }

  async create(user: AuthUser, ticketId: string, dto: CreateTicketShareDto) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { requesterId: true, assigneeId: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (!this.canManage(user, ticket)) throw new ForbiddenException('无权创建工单分享链接');

    const token = `shr_${randomBytes(32).toString('base64url')}`;
    const share = await this.prisma.ticketShare.create({
      data: {
        ticketId,
        createdById: user.id,
        label: dto.label?.trim() || '外部只读分享',
        tokenHash: this.hash(token),
        expiresAt: dto.expiresInDays
          ? new Date(Date.now() + dto.expiresInDays * 86_400_000)
          : null,
      },
      select: { id: true, label: true, expiresAt: true, revokedAt: true, createdAt: true },
    });
    await this.prisma.ticketHistory.create({
      data: {
        ticketId,
        userId: user.id,
        action: 'UPDATE',
        field: 'share_link',
        newValue: `创建分享链接：${share.label}`,
      },
    });
    // 原始 token 只走这次响应；数据库和后续列表都无法找回它。
    return { ...this.serialize(share), token };
  }

  async revoke(user: AuthUser, ticketId: string, shareId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { requesterId: true, assigneeId: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (!this.canManage(user, ticket)) throw new ForbiddenException('无权管理工单分享链接');

    const result = await this.prisma.ticketShare.updateMany({
      where: { id: shareId, ticketId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('分享链接不存在或已撤销');
    await this.prisma.ticketHistory.create({
      data: {
        ticketId,
        userId: user.id,
        action: 'UPDATE',
        field: 'share_link',
        newValue: '撤销分享链接',
      },
    });
    return { revoked: true };
  }

  private async active(token: string): Promise<ActiveShare> {
    // 固定前缀与长度检查可减少无意义的 hash/数据库工作；不向调用者泄露失效原因。
    if (!token.startsWith('shr_') || token.length < 32) {
      throw new NotFoundException('分享链接无效或已失效');
    }
    const share = await this.prisma.ticketShare.findUnique({
      where: { tokenHash: this.hash(token) },
      select: { id: true, ticketId: true, expiresAt: true, revokedAt: true },
    });
    if (!share || share.revokedAt || (share.expiresAt && share.expiresAt <= new Date())) {
      throw new NotFoundException('分享链接无效或已失效');
    }
    return share;
  }

  /** 外部页只返回公开讨论：不含内部备注、联系方式、队列/处理人/提单人邮箱和普通附件。 */
  async publicTicket(token: string) {
    const share = await this.active(token);
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: share.ticketId },
      select: {
        ticketNo: true,
        title: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        type: { select: { name: true } },
        category: { select: { name: true } },
        datacenter: { select: { name: true } },
        cluster: { select: { name: true } },
        serialNumber: true,
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            body: true,
            createdAt: true,
            author: { select: { name: true } },
          },
        },
      },
    });
    if (!ticket) throw new NotFoundException('分享链接无效或已失效');

    return {
      ...ticket,
      messages: ticket.messages.map((message) => ({
        ...message,
        // 仅将公开正文实际引用到的内联图片改成带分享密钥的受控下载地址。
        // 普通附件没有 messageId/可见性归属，默认不对外分享，避免误泄露内部材料。
        body: this.rewriteInlineImages(message.body, token),
      })),
      expiresAt: share.expiresAt,
    };
  }

  private rewriteInlineImages(body: string, token: string) {
    return rewriteAttachmentUrls(
      body,
      (attachmentId) =>
        `/api/shared-tickets/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  async publicInlineAttachment(token: string, attachmentId: string) {
    const share = await this.active(token);
    const attachment = await this.prisma.ticketAttachment.findFirst({
      where: {
        id: attachmentId,
        ticketId: share.ticketId,
        // 未绑定消息的附件不对外分享；历史正文引用已由数据迁移回填 messageId。
        messageId: { not: null },
      },
      select: {
        fileName: true,
        fileSize: true,
        mime: true,
        objectKey: true,
        messageId: true,
      },
    });
    // 只放行服务端认可的真实位图；SVG 等可执行内容即使被旧数据标成 image/* 也不暴露。
    if (!attachment || !isRasterImageMime(attachment.mime)) {
      throw new NotFoundException('附件不存在');
    }
    // 查询已排除空 messageId，这里再兜一层，避免未来改查询时把草稿图放出去。
    const messageId = attachment.messageId;
    if (!messageId) {
      throw new NotFoundException('附件不存在');
    }

    // 绑定关系优先于正文引用：内部备注的附件即使被某条公开回复引用了下载地址，
    // 也不能通过分享链接解禁。消息缺失或跨工单的脏数据同样按内部材料处理。
    const boundMessage = await this.prisma.ticketMessage.findFirst({
      where: { id: messageId, ticketId: share.ticketId },
      select: { isInternal: true },
    });
    if (!boundMessage || boundMessage.isInternal) {
      throw new NotFoundException('附件不存在');
    }

    // 再确认这条公开消息的正文确实引用了它：绑定到公开消息但已从正文移除的
    // 附件不应继续通过旧链接下载。该查询显式排除内部备注。
    if (
      !(await isReferencedByPublicMessage(
        this.prisma,
        share.ticketId,
        attachmentId,
      ))
    ) {
      throw new NotFoundException('附件不存在');
    }

    return { attachment, stream: await this.storage.getStream(attachment.objectKey) };
  }
}
