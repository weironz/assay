import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

export interface NotifyInput {
  type: string;
  title: string;
  content?: string;
  ticketId?: string;
}

const esc = (s = '') =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** 写入一条站内通知，并（若启用）发送邮件（其他模块调用） */
  async notify(userId: string, input: NotifyInput) {
    if (!userId) return;
    const rec = await this.prisma.notification.create({
      data: {
        userId,
        type: input.type,
        title: input.title,
        content: input.content,
        ticketId: input.ticketId,
      },
    });

    // 邮件通知：尽力而为，不阻塞主流程
    if (this.mail.enabled) {
      void (async () => {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });
        if (!user?.email) return;
        const link = this.mail.ticketUrl(input.ticketId);
        const html = `
          <p>${esc(input.title)}</p>
          ${input.content ? `<p>${esc(input.content)}</p>` : ''}
          <p><a href="${link}">查看工单</a></p>
          <hr><p style="color:#888;font-size:12px">来自工单管理系统的自动通知</p>`;
        await this.mail.send(user.email, input.title, html);
      })();
    }
    return rec;
  }

  list(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({
      where: { userId, isRead: false },
    });
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { ok: true };
  }
}
