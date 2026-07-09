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

@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** 上传附件到指定工单（含正文内联图片）*/
  @Post('tickets/:id/attachments')
  @RequirePermissions('ticket:comment')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: AuthUser,
    @Param('id') ticketId: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('messageId') messageId?: string,
  ) {
    return this.attachments.upload(user, ticketId, file, messageId);
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
