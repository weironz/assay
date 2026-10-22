import { AttachmentsService } from '../src/attachments/attachments.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SlaService } from '../src/sla/sla.service';
import { TicketDeletion } from '../src/tickets/ticket-deletion';
import { TicketEditor } from '../src/tickets/ticket-editor';
import { TicketLifecycle } from '../src/tickets/ticket-lifecycle';
import { TicketMessaging } from '../src/tickets/ticket-messaging';
import { TicketParticipants } from '../src/tickets/ticket-participants';
import { TicketQueries } from '../src/tickets/ticket-queries';
import { TicketsService } from '../src/tickets/tickets.service';
import { WorkflowService } from '../src/tickets/workflow.service';

/**
 * 回归测试装配帮助：TicketsService 已改为构造器注入六个域 collaborator，
 * 这里按其原始依赖（prisma/workflow/notifications/sla/attachments）组装域实现，
 * 保持各测试历史上直接 new TicketsService(...) 的调用形状。
 */
export function createTicketsService(
  prisma: PrismaService,
  workflow: WorkflowService,
  notifications: NotificationsService,
  sla: SlaService,
  attachments?: AttachmentsService,
): TicketsService {
  return new TicketsService(
    new TicketQueries(prisma, workflow),
    new TicketEditor(prisma, sla),
    new TicketLifecycle(prisma, workflow, notifications, sla),
    new TicketMessaging(prisma, notifications, sla),
    new TicketParticipants(prisma, notifications),
    new TicketDeletion(prisma, sla, attachments as AttachmentsService),
  );
}
