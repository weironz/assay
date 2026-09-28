import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SLA_QUEUE, SlaJobData, slaReceiptField } from './sla.service';

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

@Processor(SLA_QUEUE)
export class SlaProcessor extends WorkerHost {
  private readonly logger = new Logger('SLAWorker');
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) { super(); }

  async process(job: Job<SlaJobData>) {
    const { ticketId, kind, dueAt } = job.data;
    if (kind !== 'response' && kind !== 'resolve') return;
    const alert = await this.prisma.$transaction(async (tx) => {
      // Ticket updates take the same row lock; competing workers serialize here.
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId} FOR UPDATE`;
      const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });
      if (!ticket || ['PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) return;
      if (kind === 'response' && ticket.firstResponseAt) return;
      const deadline = kind === 'response' ? ticket.firstResponseDueAt : ticket.slaDueAt;
      if (!deadline || deadline.getTime() > Date.now()) return;
      if (dueAt && dueAt !== deadline.toISOString()) return;
      const field = slaReceiptField(kind);
      const receipt = deadline.toISOString();
      if (await tx.ticketHistory.findFirst({
        where: { ticketId, field, oldValue: receipt }, select: { id: true },
      })) return;
      // A legacy receipt has no deadline key. Only a later resume/reopen can
      // supersede it; earlier transitions are already covered by that alert.
      const legacyReceipt = await tx.ticketHistory.findFirst({
        where: {
          ticketId, field: 'sla',
          newValue: kind === 'response' ? '首次响应超时' : '解决超时',
          createdAt: { gte: deadline },
        },
        select: { createdAt: true }, orderBy: { createdAt: 'desc' },
      });
      if (legacyReceipt) {
        const changedAfterReceipt = await tx.ticketHistory.findFirst({
          where: {
            ticketId, field: 'status', createdAt: { gt: legacyReceipt.createdAt },
            OR: kind === 'response'
              ? [{ oldValue: 'PENDING' }]
              : [{ oldValue: 'PENDING' }, { newValue: 'REOPENED' }],
          },
          select: { id: true },
        });
        if (!changedAfterReceipt) return;
      }

      let targets: string[];
      if (kind === 'response') {
        if (ticket.assigneeId) targets = [ticket.assigneeId];
        else {
          const staff = await tx.user.findMany({
            where: { status: 'ACTIVE', roles: { some: { role: { name: { in: ['admin', 'supervisor'] } } } } },
            select: { id: true },
          });
          targets = staff.map((user) => user.id);
        }
      } else {
        targets = [ticket.assigneeId, ticket.requesterId].filter((id): id is string => !!id);
      }
      const title = kind === 'response' ? `⏰ 工单超时未响应：${ticket.ticketNo}` : `⏰ 工单已超时：${ticket.ticketNo}`;
      const content = kind === 'response'
        ? `「${ticket.title}」已超过首次响应时限仍无人回复。`
        : `「${ticket.title}」已超过 SLA 解决时限仍未完成，请尽快处理。`;
      const recipients = [...new Set(targets)];
      for (const userId of recipients) {
        await tx.notification.create({ data: {
          userId, ticketId,
          type: kind === 'response' ? 'SLA_RESPONSE_OVERDUE' : 'SLA_OVERDUE',
          title, content,
        } });
      }
      if (kind === 'resolve') {
        const index = PRIORITIES.indexOf(ticket.priority);
        if (index >= 0 && index < PRIORITIES.length - 1) {
          const next = PRIORITIES[index + 1];
          await tx.ticket.update({ where: { id: ticketId }, data: { priority: next } });
          await tx.ticketHistory.create({ data: {
            ticketId, userId: null, action: 'UPDATE', field: 'priority',
            oldValue: ticket.priority, newValue: next,
          } });
        }
      }
      await tx.ticketHistory.create({ data: {
        ticketId, userId: null, action: 'UPDATE', field,
        oldValue: receipt, newValue: kind === 'response' ? '首次响应超时' : '解决超时',
      } });
      this.logger.warn(`${kind} SLA overdue ${ticket.ticketNo}`);
      return { recipients, title, content };
    }, { timeout: 15_000 });
    // Mail remains best effort, as in NotificationsService; only the committed
    // winner sends it, so BullMQ replay cannot send a duplicate.
    if (alert && this.mail.enabled && alert.recipients.length) {
      void (async () => {
        const users = await this.prisma.user.findMany({
          where: { id: { in: alert.recipients } }, select: { email: true },
        });
        const html = `<p>${escapeHtml(alert.title)}</p><p>${escapeHtml(alert.content)}</p>`
          + `<p><a href="${this.mail.ticketUrl(ticketId)}">查看工单</a></p>`;
        await Promise.all(users.filter((user) => user.email)
          .map((user) => this.mail.send(user.email, alert.title, html)));
      })().catch((error) => this.logger.error('SLA mail failed', error));
    }
  }
}
