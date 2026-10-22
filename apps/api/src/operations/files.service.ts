import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';
import {
  ALLOWED_EXTS,
  assertAttachmentSize,
  extOf,
} from '../attachments/limits';
import { PlatformService } from './platform.service';
import { BusinessKind, serializable, writeActivity } from './business';

@Injectable()
export class BusinessFilesService {
  constructor(
    private readonly db: PrismaService,
    private readonly platform: PlatformService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}
  private serialize(record: any) {
    return {
      ...record,
      url: '/operations/attachments/' + record.id + '/download',
      objectKey: undefined,
    };
  }
  async list(user: AuthUser, kind: string, id: string) {
    await this.platform.subject(user, kind, id);
    const rows = await this.db.businessAttachment.findMany({
      where: { kind, entityId: id },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.serialize(row));
  }
  async upload(
    user: AuthUser,
    kind: string,
    id: string,
    file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('未收到文件');
    let stored = false,
      committed = false;
    const key = 'business/' + kind + '/' + id + '/' + randomUUID();
    try {
      await this.platform.subject(user, kind, id, true);
      assertAttachmentSize(file);
      if (!ALLOWED_EXTS.includes(extOf(file.originalname)))
        throw new BadRequestException('不支持的文件格式');
      await this.storage.putStream({
        key,
        body: createReadStream(file.path),
        contentType: file.mimetype,
      });
      stored = true;
      const record = await serializable(this.db, async (tx) => {
        const row = await tx.businessAttachment.create({
          data: {
            kind,
            entityId: id,
            fileName: file.originalname,
            objectKey: key,
            fileSize: file.size,
            mime: file.mimetype,
            uploaderId: user.id,
            uploaderName: user.name,
          },
        });
        await writeActivity(
          tx,
          user,
          kind as BusinessKind,
          id,
          'ATTACHMENT_ADDED',
          undefined,
          { attachmentId: row.id, fileName: row.fileName },
        );
        return row;
      });
      committed = true;
      return this.serialize(record);
    } finally {
      await unlink(file.path).catch(() => undefined);
      if (stored && !committed)
        await this.storage.delete(key).catch(() => undefined);
    }
  }
  async download(user: AuthUser, id: string) {
    const record = await this.db.businessAttachment.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('附件不存在');
    await this.platform.subject(user, record.kind, record.entityId);
    return { record, stream: await this.storage.getStream(record.objectKey) };
  }
}
