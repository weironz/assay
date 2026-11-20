import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createReadStream } from 'fs';
import { open, unlink } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';
import { AuthUser } from '../auth/auth.types';
import {
  ALLOWED_EXTS,
  MAX_ATTACHMENTS_PER_TICKET,
  MAX_DAILY_UPLOADS,
  MAX_DAILY_UPLOAD_BYTES,
  MAX_DAILY_UPLOAD_MB,
  MIME_BY_EXT,
  RASTER_IMAGE_MIME_BY_EXT,
  assertAttachmentSize,
  detectRasterImageMime,
  extOf,
  isRasterImageMime,
} from './limits';
import type { DeletionDrainResult } from './deletion-queue';
import {
  abandonPendingUpload,
  enqueueObjectDeletions,
  finalizePendingUpload,
  processObjectDeletions,
  recordPendingUpload,
} from './deletion-queue';

import {
  canViewTicket,
  TicketRoleAccess as TicketAccess,
} from '../tickets/visibility';
import {
  attachmentListWhere,
  attachmentRowVisible,
  canUploadToTicket,
  findAttachmentReference,
  inlineImageIds,
  isAttachmentDownloadable,
  isUnboundVisible,
  lockAttachments,
  messageBindingIssue,
  referencedAttachmentIds,
} from './rules';

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger('Attachments');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  private async loadTicketForAccess(ticketId: string): Promise<TicketAccess> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        requesterId: true,
        assigneeId: true,
        participants: { select: { userId: true, role: true } },
      },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    return ticket;
  }

  private assertCanView(user: AuthUser, ticket: TicketAccess) {
    if (!canViewTicket(user, ticket)) {
      throw new ForbiddenException('无权访问该工单附件');
    }
  }

  /** 上传是写操作，不能因“查看全部”而获得对他人工单上传附件的能力。 */
  private assertCanOperate(user: AuthUser, ticket: TicketAccess) {
    if (!canUploadToTicket(user, ticket)) {
      throw new ForbiddenException('无权向该工单上传附件');
    }
  }

  /**
   * 上传时校验 messageId 确实属于当前工单。
   * 关联到内部备注的附件，只有能看内部备注的人才能上传/指定。
   */
  private async assertMessageWritable(
    user: AuthUser,
    ticket: TicketAccess,
    ticketId: string,
    messageId: string,
  ) {
    const issue = await messageBindingIssue(
      this.prisma,
      user,
      ticket,
      ticketId,
      messageId,
    );
    if (issue === 'FOREIGN_MESSAGE') {
      throw new BadRequestException('附件关联的消息不属于该工单');
    }
    if (issue === 'INTERNAL_MESSAGE') {
      throw new ForbiddenException('无权向内部备注上传附件');
    }
  }

  private buildKey(ticketId: string, fileName: string) {
    const rand = Math.random().toString(36).slice(2, 10);
    const safe = fileName.replace(/[^\w.\-一-龥]/g, '_');
    return `tickets/${ticketId}/${Date.now()}-${rand}-${safe}`;
  }

  /** 先按扩展名挡一道（便宜且不读盘）；真正的 MIME 由 resolveMime 决定。 */
  private assertFileName(file: Express.Multer.File, kind?: string) {
    if (!file?.path) throw new BadRequestException('未收到文件');
    if (kind === 'inline') return;
    if (!ALLOWED_EXTS.includes(extOf(file.originalname))) {
      throw new BadRequestException(
        `不支持的文件格式，仅支持：${ALLOWED_EXTS.join('、')}`,
      );
    }
  }

  /**
   * multer 的 limit 是 MAX + 1（busboy 在「达到」时就判超限），真正的大小上限
   * 必须在这里再校验一次：控制器的配置可以被绕过，这个检查不会。
   */
  private assertSize(file: Express.Multer.File) {
    assertAttachmentSize(file);
  }

  /**
   * 存储配额：单工单附件数 + 单用户 24 小时上传次数/总量。
   *
   * 三个计数都是「先查后用」而不是事务里扣减，并发请求可能同时通过；这里的目标
   * 是挡住脚本批量刷接口和长期无限增长，不是精确计费，所以不做额外的锁。
   */
  private async assertQuota(
    user: AuthUser,
    ticketId: string | null,
    fileSize: number,
  ) {
    if (ticketId) {
      const count = await this.prisma.ticketAttachment.count({
        where: { ticketId },
      });
      if (count >= MAX_ATTACHMENTS_PER_TICKET) {
        throw new BadRequestException(
          `单个工单最多 ${MAX_ATTACHMENTS_PER_TICKET} 个附件`,
        );
      }
    }
    const usage = await this.prisma.ticketAttachment.aggregate({
      where: {
        uploaderId: user.id,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      _count: { _all: true },
      _sum: { fileSize: true },
    });
    if ((usage._count?._all ?? 0) >= MAX_DAILY_UPLOADS) {
      throw new BadRequestException(
        `24 小时内最多上传 ${MAX_DAILY_UPLOADS} 个附件`,
      );
    }
    if ((usage._sum?.fileSize ?? 0) + fileSize > MAX_DAILY_UPLOAD_BYTES) {
      throw new PayloadTooLargeException(
        `24 小时内上传总量不能超过 ${MAX_DAILY_UPLOAD_MB}MB`,
      );
    }
  }

  private async readImageMime(file: Express.Multer.File) {
    const handle = await open(file.path, 'r');
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return detectRasterImageMime(header.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  /**
   * 服务端认定 MIME：图片按 magic bytes 核对并归一化，其他附件按扩展名白名单映射。
   * 客户端 multipart 的 Content-Type 只用于展示，绝不落库。
   *
   * kind=inline 是正文里粘贴/拖进来的图片：截图常常是 webp/gif，不能按附件扩展名
   * 白名单挡；但同样只接受真实的位图，SVG/HTML 一律拒绝。
   */
  private async resolveMime(file: Express.Multer.File, kind?: string) {
    const ext = extOf(file.originalname);
    if (kind === 'inline') {
      const detected = await this.readImageMime(file);
      if (!detected) {
        throw new BadRequestException('内联插图仅支持 PNG / JPG / GIF / WEBP 图片');
      }
      return detected;
    }
    const expected = RASTER_IMAGE_MIME_BY_EXT[ext];
    if (expected) {
      const detected = await this.readImageMime(file);
      if (detected !== expected) {
        throw new BadRequestException('文件内容与扩展名不符，请上传真实的图片文件');
      }
      return detected;
    }
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
  }

  /** multer 的临时文件必须在任何失败路径上删除，否则可被反复上传撑满磁盘。 */
  private async discardTemp(file?: Express.Multer.File) {
    if (!file?.path) return;
    await unlink(file.path).catch(() => undefined);
  }

  async upload(
    user: AuthUser,
    ticketId: string,
    file: Express.Multer.File,
    messageId?: string,
    kind?: string,
  ) {
    try {
      this.assertFileName(file, kind);
      this.assertSize(file);
      const ticket = await this.loadTicketForAccess(ticketId);
      this.assertCanOperate(user, ticket);
      if (messageId) {
        await this.assertMessageWritable(user, ticket, ticketId, messageId);
      }
      const mime = await this.resolveMime(file, kind);
      return await this.store(user, file, ticketId, messageId, mime, kind === 'inline');
    } finally {
      await this.discardTemp(file);
    }
  }

  /** 草稿上传：建单前上传（图片/附件），ticketId 暂为 null，提交时再关联 */
  async uploadDraft(user: AuthUser, file: Express.Multer.File, kind?: string) {
    try {
      this.assertFileName(file, kind);
      this.assertSize(file);
      const mime = await this.resolveMime(file, kind);
      return await this.store(user, file, null, undefined, mime, kind === 'inline');
    } finally {
      await this.discardTemp(file);
    }
  }

  private async store(
    user: AuthUser,
    file: Express.Multer.File,
    ticketId: string | null,
    messageId: string | undefined,
    mime: string,
    isInline: boolean,
  ) {
    await this.assertQuota(user, ticketId, file.size);
    const objectKey = this.buildKey(ticketId ?? 'draft', file.originalname);

    await recordPendingUpload(this.prisma, objectKey);

    // 调用方（upload/uploadDraft）在 finally 里统一清理临时文件，这里只负责持久化。
    try {
      await this.storage.putStream({
        key: objectKey,
        body: createReadStream(file.path),
        contentType: mime,
      });
      const rec = await this.prisma.$transaction(async (tx) => {
        const created = await tx.ticketAttachment.create({
          data: {
            ticketId,
            messageId: messageId ?? null,
            fileName: file.originalname,
            objectKey,
            fileSize: file.size,
            mime,
            isInline,
            uploaderId: user.id,
          },
        });
        await finalizePendingUpload(tx, objectKey);
        return created;
      });
      return this.serialize(rec);
    } catch (error) {
      await abandonPendingUpload(this.prisma, this.storage, this.logger, objectKey);
      throw error;
    }
  }

  /**
   * 把待删对象 key 写进 outbox。调用方必须传入事务客户端，保证「业务记录删除 +
   * 待删 key 落库」原子提交；对象本身由后台任务重试删除，不在事务内做网络 IO。
   */
  async queueObjectDeletions(
    tx: Prisma.TransactionClient,
    objectKeys: readonly string[],
    reason: string,
  ) {
    return enqueueObjectDeletions(tx, objectKeys, reason);
  }

  /** 立即尝试处理到期的删除任务；失败会留在 outbox 里，由定时任务重试。 */
  async processPendingDeletions(now = new Date()): Promise<DeletionDrainResult> {
    try {
      return await processObjectDeletions(
        this.prisma,
        this.storage,
        this.logger,
        now,
      );
    } catch (error) {
      this.logger.error('附件删除队列处理失败', error as Error);
      return { deleted: 0, retrying: 0 };
    }
  }

  async list(user: AuthUser, ticketId: string) {
    const ticket = await this.loadTicketForAccess(ticketId);
    this.assertCanView(user, ticket);
    const rows = await this.prisma.ticketAttachment.findMany({
      where: attachmentListWhere(user, ticket, ticketId),
      // 带上消息可见性，内存兜底过滤才能真正判断已绑定附件的归属。
      include: { message: { select: { isInternal: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows
      // 查询条件已是最终口径（attachmentListWhere），这里再兜一层，避免将来
      // 改查询时把未绑定记录或绑定到内部备注的记录带出去。
      .filter((row) => attachmentRowVisible(user, ticket, row))
      .map((row) => this.serialize(row));
  }

  /** 只允许上传者删除本人附件；正文仍引用时先要求移除引用。 */
  async remove(user: AuthUser, id: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const rec = await tx.ticketAttachment.findUnique({ where: { id } });
      if (!rec) throw new NotFoundException('附件不存在');
      if (rec.uploaderId !== user.id) throw new ForbiddenException('只能删除自己上传的附件');
      if (rec.ticketId) {
        if (!user.permissions.includes('ticket:comment')) throw new ForbiddenException('缺少工单回复权限');
        const ticket = await tx.ticket.findUnique({
          where: { id: rec.ticketId },
          select: { requesterId: true, assigneeId: true, participants: { select: { userId: true, role: true } } },
        });
        if (!ticket) throw new NotFoundException('工单不存在');
        if (!canUploadToTicket(user, ticket)) throw new ForbiddenException('无权操作该工单');
      } else if (!user.permissions.includes('ticket:create')) {
        throw new ForbiddenException('缺少创建工单权限');
      }
      await lockAttachments(tx, [id]);
      if (await findAttachmentReference(tx, id)) {
        throw new BadRequestException('附件仍被工单正文引用，请先移除引用');
      }
      const deleted = await tx.ticketAttachment.deleteMany({
        where: { id, uploaderId: user.id, ticketId: rec.ticketId, messageId: rec.messageId },
      });
      if (deleted.count !== 1) throw new BadRequestException('附件状态已变化，请刷新后重试');
      await enqueueObjectDeletions(tx, [rec.objectKey], 'ATTACHMENT_DELETED');
      if (rec.ticketId) await tx.ticketHistory.create({ data: {
        ticketId: rec.ticketId, userId: user.id, action: 'UPDATE', field: 'attachment',
        oldValue: rec.fileName, newValue: '删除附件',
      } });
      return { ok: true };
    }, { isolationLevel: 'ReadCommitted' });
    void this.processPendingDeletions().catch(() => undefined);
    return result;
  }

  /** Called while holding the referenced attachment rows. Delete only images
   * whose removal was part of this edit, and retain explicitly uploaded files. */
  async queueRemovedInlineImages(
    tx: Prisma.TransactionClient,
    ticketId: string,
    messageId: string,
    authorId: string,
    before: string,
    after: string,
  ): Promise<number> {
    const remaining = referencedAttachmentIds(after);
    const remainingImages = inlineImageIds(after);
    const removed = [...referencedAttachmentIds(before)].filter(id => !remaining.has(id));
    const removedImages = [...inlineImageIds(before)].filter(id => !remainingImages.has(id));
    if (!removed.length && !removedImages.length) return 0;

    const legacyImages = await tx.ticketAttachment.findMany({
      where: { ticketId, messageId, uploaderId: authorId, isInline: null, id: { in: removedImages } },
      select: { id: true, mime: true },
    });
    const legacyIds = legacyImages.filter(row => isRasterImageMime(row.mime)).map(row => row.id);
    if (legacyIds.length) {
      // Persist attribution even if a second message or a plain link still uses the image.
      await tx.ticketAttachment.updateMany({ where: { id: { in: legacyIds } }, data: { isInline: true } });
    }
    if (!removed.length) return 0;

    const objects: string[] = [];
    const candidates = await tx.ticketAttachment.findMany({
      where: { isInline: true, messageId: { not: null }, id: { in: removed } },
      select: { id: true, objectKey: true },
    });
    for (const candidate of candidates) {
      if (await findAttachmentReference(tx, candidate.id)) continue;
      await tx.ticketAttachment.delete({ where: { id: candidate.id } });
      objects.push(candidate.objectKey);
    }
    return enqueueObjectDeletions(tx, objects, 'INLINE_IMAGE_REMOVED');
  }

  async getForDownload(user: AuthUser, id: string) {
    const rec = await this.prisma.ticketAttachment.findUnique({
      where: { id },
    });
    if (!rec) throw new NotFoundException('附件不存在');
    // 已挂工单的按工单可见性校验；草稿附件（ticketId 为空）仅上传者本人可下载
    if (rec.ticketId) {
      const ticket = await this.loadTicketForAccess(rec.ticketId);
      this.assertCanView(user, ticket);
      if (!(await isAttachmentDownloadable(this.prisma, user, ticket, rec))) {
        throw new ForbiddenException('无权访问该附件');
      }
    } else if (!isUnboundVisible(rec, user)) {
      throw new ForbiddenException('无权访问该附件');
    }
    // 返回流而不是 Buffer：512MB 的附件整包读进内存下载一次就够呛
    const stream = await this.storage.getStream(rec.objectKey);
    return { rec, stream };
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
