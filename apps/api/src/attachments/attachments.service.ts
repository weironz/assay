import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';
import { AuthUser } from '../auth/auth.types';

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

  async upload(
    user: AuthUser,
    ticketId: string,
    file: Express.Multer.File,
    messageId?: string,
  ) {
    await this.assertCanView(user, ticketId);
    const objectKey = this.buildKey(ticketId, file.originalname);
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
    await this.assertCanView(user, rec.ticketId);
    const body = await this.storage.get(rec.objectKey);
    return { rec, body };
  }

  private serialize(r: {
    id: string;
    fileName: string;
    fileSize: number;
    mime: string;
    ticketId: string;
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
