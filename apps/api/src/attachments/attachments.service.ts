import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { open, unlink } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';
import { AuthUser } from '../auth/auth.types';
import {
  ALLOWED_EXTS,
  MIME_BY_EXT,
  RASTER_IMAGE_MIME_BY_EXT,
  detectRasterImageMime,
  extOf,
} from './limits';
import { loadAttachmentReferences } from './visibility';

type TicketAccess = {
  requesterId: string;
  assigneeId: string | null;
  participants: { userId: string; role: string }[];
};

@Injectable()
export class AttachmentsService {
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
    if (user.permissions.includes('ticket:read:all')) return;
    if (
      ticket.requesterId !== user.id &&
      ticket.assigneeId !== user.id &&
      !ticket.participants.some((participant) => participant.userId === user.id)
    ) {
      throw new ForbiddenException('无权访问该工单附件');
    }
  }

  /**
   * 谁能看内部备注。与 TicketsService.isInternalParticipant 保持一致：
   * 管理岗、当前处理人、协作成员。仅有 ticket:read:all 的只读账号也不行。
   */
  private isInternalParticipant(user: AuthUser, ticket: TicketAccess) {
    return (
      user.roles.includes('admin') ||
      user.roles.includes('supervisor') ||
      ticket.assigneeId === user.id ||
      ticket.participants.some(
        (participant) =>
          participant.userId === user.id && participant.role === 'COLLABORATOR',
      )
    );
  }

  /** 上传是写操作，不能因“查看全部”而获得对他人工单上传附件的能力。 */
  private assertCanOperate(user: AuthUser, ticket: TicketAccess) {
    const staff = user.roles.includes('admin') || user.roles.includes('supervisor');
    const collaborator = ticket.participants.some(
      (participant) =>
        participant.userId === user.id && participant.role === 'COLLABORATOR',
    );
    if (!staff && !collaborator && ticket.requesterId !== user.id && ticket.assigneeId !== user.id) {
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
    const message = await this.prisma.ticketMessage.findFirst({
      where: { id: messageId, ticketId },
      select: { isInternal: true },
    });
    if (!message) {
      throw new BadRequestException('附件关联的消息不属于该工单');
    }
    if (message.isInternal && !this.isInternalParticipant(user, ticket)) {
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
      const ticket = await this.loadTicketForAccess(ticketId);
      this.assertCanOperate(user, ticket);
      if (messageId) {
        await this.assertMessageWritable(user, ticket, ticketId, messageId);
      }
      const mime = await this.resolveMime(file, kind);
      return await this.store(user, file, ticketId, messageId, mime);
    } finally {
      await this.discardTemp(file);
    }
  }

  /** 草稿上传：建单前上传（图片/附件），ticketId 暂为 null，提交时再关联 */
  async uploadDraft(user: AuthUser, file: Express.Multer.File, kind?: string) {
    try {
      this.assertFileName(file, kind);
      const mime = await this.resolveMime(file, kind);
      return await this.store(user, file, null, undefined, mime);
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
  ) {
    const objectKey = this.buildKey(ticketId ?? 'draft', file.originalname);
    // 调用方（upload/uploadDraft）在 finally 里统一清理临时文件，这里只负责持久化。
    await this.storage.putStream({
      key: objectKey,
      body: createReadStream(file.path),
      contentType: mime,
    });
    const rec = await this.prisma.ticketAttachment.create({
      data: {
        ticketId,
        messageId: messageId ?? null,
        fileName: file.originalname,
        objectKey,
        fileSize: file.size,
        mime,
        uploaderId: user.id,
      },
    });
    return this.serialize(rec);
  }

  /**
   * 非内部成员的附件可见性。
   *
   * 已绑定消息的附件只认消息的 isInternal；绑定关系是权威的，公开正文里出现
   * 同一个下载地址也不能把内部消息的附件解禁。
   *
   * 编辑器「先传图、再发消息」留下的未绑定历史附件没有 messageId，只能看正文
   * 引用：只要内部备注引用过就按内部材料处理（内部优先）。公开正文再引用一次
   * 不能覆盖内部引用，否则历史内部附件 ID 可以被写成公开回复后重新下载。
   */
  private async hiddenAttachmentIds(
    ticketId: string,
    user: AuthUser,
    ticket: TicketAccess,
  ) {
    if (this.isInternalParticipant(user, ticket)) return new Set<string>();
    const { internalIds } = await loadAttachmentReferences(this.prisma, ticketId);
    return internalIds;
  }

  async list(user: AuthUser, ticketId: string) {
    const ticket = await this.loadTicketForAccess(ticketId);
    this.assertCanView(user, ticket);
    const internal = this.isInternalParticipant(user, ticket);
    const hidden = internal
      ? new Set<string>()
      : await this.hiddenAttachmentIds(ticketId, user, ticket);
    const rows = await this.prisma.ticketAttachment.findMany({
      where: {
        ticketId,
        // 内部备注的附件只对内部成员可见；没有 messageId 的历史数据由 hidden 兜底。
        ...(internal
          ? {}
          : { OR: [{ messageId: null }, { message: { isInternal: false } }] }),
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows
      // 正文引用只用于兜底没有 messageId 的历史附件；已绑定的以消息可见性为准，
      // 不能因为内部备注也引用了某个公开附件而把公开附件一起隐藏。
      .filter((row) => row.messageId !== null || !hidden.has(row.id))
      .map((row) => this.serialize(row));
  }

  private async assertAttachmentVisible(
    user: AuthUser,
    ticket: TicketAccess,
    rec: { id: string; ticketId: string; messageId: string | null },
  ) {
    if (rec.messageId) {
      const message = await this.prisma.ticketMessage.findFirst({
        where: { id: rec.messageId, ticketId: rec.ticketId },
        select: { isInternal: true },
      });
      // 消息不存在（脏数据）同样按内部材料处理，避免默认放行。
      if (!message || message.isInternal) {
        throw new ForbiddenException('无权访问该附件');
      }
      return;
    }
    const hidden = await this.hiddenAttachmentIds(rec.ticketId, user, ticket);
    if (hidden.has(rec.id)) throw new ForbiddenException('无权访问该附件');
  }

  async getForDownload(user: AuthUser, id: string) {
    const rec = await this.prisma.ticketAttachment.findUnique({
      where: { id },
    });
    if (!rec) throw new NotFoundException('附件不存在');
    // 已挂工单的按工单可见性校验；草稿附件（ticketId 为空）仅上传者本人可下载
    if (rec.ticketId) {
      const ticketId = rec.ticketId;
      const ticket = await this.loadTicketForAccess(ticketId);
      this.assertCanView(user, ticket);
      if (!this.isInternalParticipant(user, ticket)) {
        await this.assertAttachmentVisible(user, ticket, {
          id: rec.id,
          ticketId,
          messageId: rec.messageId,
        });
      }
    } else if (rec.uploaderId !== user.id) {
      throw new ForbiddenException('无权访问该附件');
    }
    // 返回流而不是 Buffer：512MB 的附件整包读进内存下载一次就够呛
    const stream = await this.storage.getStream(rec.objectKey);
    return { rec, stream };
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
