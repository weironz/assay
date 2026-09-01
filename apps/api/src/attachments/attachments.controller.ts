import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { MAX_ATTACHMENT_BYTES, UPLOAD_TMP_DIR } from './limits';

/**
 * 落临时盘而不是进内存。默认的 memoryStorage 会把整个文件读进 RAM——
 * 512MB 的附件就是 512MB 常驻内存，两个人同传直接把容器打爆。
 * 落盘后由 service 以流的方式转给对象存储，内存占用与文件大小无关。
 * 超限的请求由 limits 在写盘过程中掐断，不会等整个文件传完再拒绝。
 */
const UPLOAD_OPTS = {
  storage: diskStorage({ destination: UPLOAD_TMP_DIR || tmpdir() }),
  // +1 是必要的：busboy 在字节数「达到」limit 时就判超限，不是超过才判。
  // 直接填 MAX 会让正好 512MB 的文件被拒，而界面写的是「不得超过 512M」，
  // 前端也按 size > MAX 放行，两边就对不上了。
  limits: { fileSize: MAX_ATTACHMENT_BYTES + 1 },
};

@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** 上传附件到指定工单（含正文内联图片）*/
  @Post('tickets/:id/attachments')
  @RequirePermissions('ticket:comment')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTS))
  upload(
    @CurrentUser() user: AuthUser,
    @Param('id') ticketId: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('messageId') messageId?: string,
    @Query('kind') kind?: string,
  ) {
    return this.attachments.upload(user, ticketId, file, messageId, kind);
  }

  /** 草稿上传：建单前上传图片/附件（提交工单时通过 attachmentIds 关联） */
  @Post('uploads')
  @RequirePermissions('ticket:create')
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTS))
  uploadDraft(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Query('kind') kind?: string,
  ) {
    return this.attachments.uploadDraft(user, file, kind);
  }

  @Get('tickets/:id/attachments')
  @RequirePermissions('ticket:read')
  list(@CurrentUser() user: AuthUser, @Param('id') ticketId: string) {
    return this.attachments.list(user, ticketId);
  }

  /** 代理下载（鉴权 + 可见性校验），供 <img>/下载链接使用 */
  @Get('attachments/:id/download')
  @RequirePermissions('ticket:read')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { rec, stream } = await this.attachments.getForDownload(user, id);
    res.setHeader('Content-Type', rec.mime);
    res.setHeader('Content-Length', String(rec.fileSize));
    const isImage = rec.mime.startsWith('image/');
    res.setHeader(
      'Content-Disposition',
      `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(
        rec.fileName,
      )}`,
    );
    // 直接转发流。客户端中途断开时要销毁上游流，否则连接会一直挂着
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
