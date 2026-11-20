import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { SlaService } from '../sla/sla.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { loadTicketOrThrow } from './core';

/**
 * 工单删除域（管理员 / 提单人本人）。
 * 注册为 TicketsModule provider，由 TicketsService 构造器注入并委派。
 */
@Injectable()
export class TicketDeletion {
  private readonly logger = new Logger(TicketDeletion.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly sla: SlaService,
    private readonly attachments: AttachmentsService,
  ) {}

  async remove(user: AuthUser, id: string) {
    const ticket = await loadTicketOrThrow(this.prisma, id);
    // 提单人可以撤掉自己提的单；别人的单只有管理员能删
    if (!user.roles.includes('admin') && ticket.requesterId !== user.id) {
      throw new ForbiddenException('只能删除自己提交的工单');
    }

    // 对象存储不能在数据库事务里删：先把待删 key 和业务删除写进同一事务。
    // 工单删除会级联删除消息、附件记录和历史；这些记录与 outbox 一起原子提交，
    // 不会出现「记录删了但 key 丢了」。事务提交后再立即尝试删对象，失败由
    // 持久化 outbox 重试并告警。
    await this.prisma.$transaction(async (tx) => {
      // Attachments acquire a foreign-key lock on the parent when inserted.
      // Wait for existing uploads and block new rows before collecting keys.
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR UPDATE`;
      const attachments = await tx.ticketAttachment.findMany({
        where: { ticketId: id },
        select: { objectKey: true },
      });
      await this.attachments.queueObjectDeletions(
        tx,
        attachments.map((attachment) => attachment.objectKey),
        'TICKET_DELETED',
      );
      await tx.ticket.delete({ where: { id } });
    }, { isolationLevel: 'ReadCommitted' });

    void this.sla.cancel(id).catch(error => this.logger.warn('SLA cancellation after deletion failed', error));
    void this.attachments.processPendingDeletions();
    return { ok: true };
  }
}
