import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Public, RequirePermissions } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { CreateTicketShareDto } from './ticket-shares.dto';
import { TicketSharesService } from './ticket-shares.service';

@Controller('tickets/:ticketId/shares')
export class TicketSharesController {
  constructor(private readonly shares: TicketSharesService) {}

  @Get()
  @RequirePermissions('ticket:read')
  list(@CurrentUser() user: AuthUser, @Param('ticketId') ticketId: string) {
    return this.shares.list(user, ticketId);
  }

  @Post()
  @RequirePermissions('ticket:read')
  create(
    @CurrentUser() user: AuthUser,
    @Param('ticketId') ticketId: string,
    @Body() dto: CreateTicketShareDto,
  ) {
    return this.shares.create(user, ticketId, dto);
  }

  @Delete(':shareId')
  @RequirePermissions('ticket:read')
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('ticketId') ticketId: string,
    @Param('shareId') shareId: string,
  ) {
    return this.shares.revoke(user, ticketId, shareId);
  }
}

/** 不经登录的窄读接口：只有持有不可猜测分享密钥的人能访问。 */
@Controller('shared-tickets')
export class PublicTicketSharesController {
  constructor(private readonly shares: TicketSharesService) {}

  @Get(':token')
  @Public()
  get(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 分享 URL 本身就是访问凭据：不能被浏览器共享缓存、CDN 或搜索引擎保存。
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.shares.publicTicket(token);
  }

  @Get(':token/attachments/:attachmentId')
  @Public()
  async inlineImage(
    @Param('token') token: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const { attachment, stream } = await this.shares.publicInlineAttachment(token, attachmentId);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', attachment.mime);
    res.setHeader('Content-Length', String(attachment.fileSize));
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    );
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
