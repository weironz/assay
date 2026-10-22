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
} from './limits';
import type { DeletionDrainResult } from './deletion-queue';
import {
  enqueueObjectDeletions,
  processObjectDeletions,
} from './deletion-queue';

type TicketAccess = {
  requesterId: string;
  assigneeId: string | null;
  participants: { userId: string; role: string }[];
};

/**
 * 上传中的对象先登记为「待删除」，正常落库后在同一事务里撤销登记。
 * 给正在上传的对象留 1 小时窗口，避免后台清理任务把还没传完的对象删掉。
 */
const UPLOAD_PENDING_GRACE_MS = 60 * 60 * 1000;

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
      return await this.store(user, file, ticketId, messageId, mime);
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
    await this.assertQuota(user, ticketId, file.size);
    const objectKey = this.buildKey(ticketId ?? 'draft', file.originalname);

    // 先登记待删除，再写对象。这样即使后面的落库失败、数据库暂时不可用，
    // 对象 key 也已经在 outbox 里，不会变成再也定位不到的孤儿。
    // 正常上传成功后，这个登记会和附件记录在同一事务里撤销。
    await enqueueObjectDeletions(
      this.prisma,
      [objectKey],
      'UPLOAD_PENDING',
      new Date(Date.now() + UPLOAD_PENDING_GRACE_MS),
    );

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
            uploaderId: user.id,
          },
        });
        // 附件记录与「撤销待删除」必须原子提交：只删登记不建记录会丢对象，
        // 只建记录不删登记则后台会误删仍在使用的对象。登记已不存在说明后台
        // 已经把对象清掉（例如上传耗时超过保护窗口），此时不能落一条坏记录。
        const cleared = await tx.attachmentDeletionTask.deleteMany({
          where: { objectKey, reason: 'UPLOAD_PENDING' },
        });
        if (!cleared.count) {
          throw new Error('上传待删除登记已失效，拒绝创建附件记录');
        }
        return created;
      });
      return this.serialize(rec);
    } catch (error) {
      // 上传中途失败会留下写了一半的对象，DB 落库失败时对象也已经写进桶了：
      // 两种情况都必须回删。待删除登记已经存在，回删成功后撤销它；回删失败
      // 则把登记提前到当前时间，让后台 worker 立刻重试。
      try {
        await this.storage.delete(objectKey);
      } catch (cleanupError) {
        this.logger.error(
          `附件对象回滚失败（key=${objectKey}）：${(cleanupError as Error).message}`,
        );
        await this.prisma.attachmentDeletionTask
          .updateMany({
            where: { objectKey, reason: 'UPLOAD_PENDING' },
            data: {
              nextAttemptAt: new Date(),
              lastError: (cleanupError as Error).message.slice(0, 2000),
            },
          })
          .catch((queueError) => {
            this.logger.error(
              `附件对象回滚失败且无法更新删除队列（key=${objectKey}）：${(queueError as Error).message}`,
            );
          });
        throw error;
      }
      // 对象已回删；清掉待删除登记。即使这一步失败，worker 重删一次对象也是幂等的。
      await this.prisma.attachmentDeletionTask
        .deleteMany({ where: { objectKey, reason: 'UPLOAD_PENDING' } })
        .catch((queueError) => {
          this.logger.error(
            `附件对象回滚后无法清理删除队列（key=${objectKey}）：${(queueError as Error).message}`,
          );
        });
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

  /**
   * 未绑定消息的附件对非内部成员是否可见。
   *
   * 编辑器是「先传图、再发消息」：图片上传时 messageId 还是空的，消息落库后才
   * 由 TicketsService.linkReferencedAttachments 绑定。这个窗口期只有上传者本人
   * 能看自己的草稿图；历史数据里的正文引用已在迁移中回填 messageId，不再用
   * 「公开正文引用过」作为放行条件——否则猜到附件 ID 的人就能绕过消息可见性。
   * 内部参与方不经过这里，直接按工单可见性放行。
   */
  private unboundVisible(
    attachment: { id: string; uploaderId: string },
    user: AuthUser,
  ) {
    return attachment.uploaderId === user.id;
  }

  async list(user: AuthUser, ticketId: string) {
    const ticket = await this.loadTicketForAccess(ticketId);
    this.assertCanView(user, ticket);
    const internal = this.isInternalParticipant(user, ticket);
    const rows = await this.prisma.ticketAttachment.findMany({
      where: {
        ticketId,
        // 非内部成员：已绑定消息的按消息可见性取；未绑定的只返回自己上传的草稿。
        ...(internal
          ? {}
          : {
              OR: [
                {
                  messageId: { not: null },
                  message: { isInternal: false, ticketId },
                },
                { messageId: null, uploaderId: user.id },
              ],
            }),
      },
      // 带上消息可见性，内存兜底过滤才能真正判断已绑定附件的归属。
      include: { message: { select: { isInternal: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows
      // 查询条件已是最终口径，这里再兜一层，避免将来改查询时把未绑定记录或
      // 绑定到内部备注的记录带出去。
      .filter((row) => {
        if (internal) return true;
        if (row.messageId === null) return this.unboundVisible(row, user);
        return row.message?.isInternal === false;
      })
      .map((row) => this.serialize(row));
  }

  private async assertAttachmentVisible(
    user: AuthUser,
    rec: {
      id: string;
      ticketId: string;
      messageId: string | null;
      uploaderId: string;
    },
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
    // 未绑定消息：只允许上传者本人；历史引用已由迁移回填，不能再按正文引用放行。
    if (!this.unboundVisible(rec, user)) {
      throw new ForbiddenException('无权访问该附件');
    }
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
        await this.assertAttachmentVisible(user, {
          id: rec.id,
          ticketId,
          messageId: rec.messageId,
          uploaderId: rec.uploaderId,
        });
      }
    } else if (rec.uploaderId !== user.id) {
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
