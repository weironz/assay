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
import { createAttachmentUploadOptions, downloadResponse } from './limits';

const UPLOAD_OPTS = createAttachmentUploadOptions();

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
    // 只信服务端归一化过的 MIME：历史数据里的 image/svg+xml 等一律转成附件下载。
    const { mime, inline } = downloadResponse(rec);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(rec.fileSize));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(
        rec.fileName,
      )}`,
    );
    // 直接转发流。客户端中途断开时要销毁上游流，否则连接会一直挂着；
    // 存储读流出错时也要销毁响应，否则 'error' 没有监听器会变成未捕获异常。
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
