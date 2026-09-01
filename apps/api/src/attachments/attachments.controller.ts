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
import { MAX_ATTACHMENT_BYTES } from './limits';

/** 超限的请求在进内存前就被 multer 掐断，不会先缓冲完再拒绝 */
const UPLOAD_OPTS = { limits: { fileSize: MAX_ATTACHMENT_BYTES } };

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
    const { rec, body } = await this.attachments.getForDownload(user, id);
    res.setHeader('Content-Type', rec.mime);
    const isImage = rec.mime.startsWith('image/');
    res.setHeader(
      'Content-Disposition',
      `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(
        rec.fileName,
      )}`,
    );
    res.send(body);
  }
}
