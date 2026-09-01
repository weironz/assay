import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';
import { AuthUser } from '../auth/auth.types';
import { ALLOWED_EXTS, extOf, isInlineImage } from './limits';

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  private async assertCanView(user: AuthUser, ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { requesterId: true, assigneeId: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    const staff =
      user.roles.includes('admin') || user.roles.includes('supervisor');
    if (
      !staff &&
      ticket.requesterId !== user.id &&
      ticket.assigneeId !== user.id
    ) {
      throw new ForbiddenException('无权访问该工单附件');
    }
  }

  private buildKey(ticketId: string, fileName: string) {
    const rand = Math.random().toString(36).slice(2, 10);
    const safe = fileName.replace(/[^\w.\-一-龥]/g, '_');
    return `tickets/${ticketId}/${Date.now()}-${rand}-${safe}`;
  }

  /**
   * 类型校验。kind=inline 是正文里粘贴/拖进来的图片，只要求是图片格式——
   * 截图常常是 webp/gif，用附件白名单去挡会把粘贴功能整个废掉。
   * 其余走显式附件的白名单。
   */
  private assertAllowed(file: Express.Multer.File, kind?: string) {
    if (!file) throw new BadRequestException('未收到文件');
    if (kind === 'inline') {
      if (!isInlineImage(file.mimetype)) {
        throw new BadRequestException('内联插图仅支持图片格式');
      }
      return;
    }
    if (!ALLOWED_EXTS.includes(extOf(file.originalname))) {
      throw new BadRequestException(
        `不支持的文件格式，仅支持：${ALLOWED_EXTS.join('、')}`,
      );
    }
  }

  async upload(
    user: AuthUser,
    ticketId: string,
    file: Express.Multer.File,
    messageId?: string,
    kind?: string,
  ) {
    this.assertAllowed(file, kind);
    await this.assertCanView(user, ticketId);
    return this.store(user, file, ticketId, messageId);
  }

  /** 草稿上传：建单前上传（图片/附件），ticketId 暂为 null，提交时再关联 */
  async uploadDraft(user: AuthUser, file: Express.Multer.File, kind?: string) {
    this.assertAllowed(file, kind);
    return this.store(user, file, null);
  }

  private async store(
    user: AuthUser,
    file: Express.Multer.File,
    ticketId: string | null,
    messageId?: string,
  ) {
    const objectKey = this.buildKey(ticketId ?? 'draft', file.originalname);
    await this.storage.put({
      key: objectKey,
      body: file.buffer,
      contentType: file.mimetype,
    });
    const rec = await this.prisma.ticketAttachment.create({
      data: {
        ticketId,
        messageId: messageId ?? null,
        fileName: file.originalname,
        objectKey,
        fileSize: file.size,
        mime: file.mimetype,
        uploaderId: user.id,
      },
    });
    return this.serialize(rec);
  }

  async list(user: AuthUser, ticketId: string) {
    await this.assertCanView(user, ticketId);
    const rows = await this.prisma.ticketAttachment.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  async getForDownload(user: AuthUser, id: string) {
    const rec = await this.prisma.ticketAttachment.findUnique({
      where: { id },
    });
    if (!rec) throw new NotFoundException('附件不存在');
    // 草稿附件(ticketId 为空)：登录用户即可访问；已挂工单的按工单可见性校验
    if (rec.ticketId) await this.assertCanView(user, rec.ticketId);
    const body = await this.storage.get(rec.objectKey);
    return { rec, body };
  }

  /** 将草稿附件关联到新建的工单（仅本人上传的草稿） */
  async linkDrafts(userId: string, ticketId: string, ids: string[]) {
    if (!ids?.length) return;
    await this.prisma.ticketAttachment.updateMany({
      where: { id: { in: ids }, uploaderId: userId, ticketId: null },
      data: { ticketId },
    });
  }

  private serialize(r: {
    id: string;
    fileName: string;
    fileSize: number;
    mime: string;
    ticketId: string | null;
    messageId: string | null;
  }) {
    return {
      id: r.id,
      fileName: r.fileName,
      fileSize: r.fileSize,
      mime: r.mime,
      ticketId: r.ticketId,
      messageId: r.messageId,
      // 走后端代理下载（endpoint 无关，附带会话鉴权）
      url: `/attachments/${r.id}/download`,
    };
  }
}
