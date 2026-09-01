import { Injectable, Logger } from '@nestjs/common';
import {
  appUrl,
  mailEnabled,
  mailProvider,
  sendMailSafe,
} from './mailer';

/**
 * 邮件服务（Nest 侧薄封装，实际发信在 mailer.ts）。
 * 未配置发信服务时静默跳过，不影响主流程。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');

  constructor() {
    this.logger.log(
      mailEnabled
        ? `邮件通知已启用 (provider=${mailProvider})`
        : '未配置发信服务，邮件通知已禁用',
    );
  }

  get enabled(): boolean {
    return mailEnabled;
  }

  ticketUrl(ticketId?: string | null): string {
    return ticketId ? `${appUrl()}/tickets/${ticketId}` : appUrl();
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    await sendMailSafe(to, subject, html);
  }
}
