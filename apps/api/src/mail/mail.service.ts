import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * 邮件服务：配置了 SMTP_* 环境变量才启用，否则静默跳过（不影响主流程）。
 * 发送为尽力而为，失败仅记日志。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transporter?: nodemailer.Transporter;
  private readonly from: string;
  private readonly appUrl: string;

  constructor() {
    const host = process.env.SMTP_HOST;
    this.from = process.env.SMTP_FROM || '工单系统 <no-reply@example.com>';
    this.appUrl =
      process.env.APP_URL ||
      (process.env.AUTH_TRUST_ORIGINS || '').split(',')[0] ||
      'http://localhost:5173';

    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: (process.env.SMTP_SECURE || 'false') === 'true',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
      this.logger.log(`邮件通知已启用 (SMTP ${host})`);
    } else {
      this.logger.log('未配置 SMTP，邮件通知已禁用');
    }
  }

  get enabled(): boolean {
    return !!this.transporter;
  }

  ticketUrl(ticketId?: string | null): string {
    return ticketId ? `${this.appUrl}/tickets/${ticketId}` : this.appUrl;
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter || !to) return;
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, html });
    } catch (e) {
      this.logger.warn(`邮件发送失败 -> ${to}: ${(e as Error).message}`);
    }
  }
}
