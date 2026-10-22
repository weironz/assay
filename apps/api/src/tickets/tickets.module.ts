import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { WorkflowService } from './workflow.service';
import { MetaController } from './meta.controller';
import { AttachmentsModule } from '../attachments/attachments.module';
import { TicketQueries } from './ticket-queries';
import { TicketEditor } from './ticket-editor';
import { TicketLifecycle } from './ticket-lifecycle';
import { TicketMessaging } from './ticket-messaging';
import { TicketParticipants } from './ticket-participants';
import { TicketDeletion } from './ticket-deletion';

@Module({
  imports: [AttachmentsModule],
  controllers: [TicketsController, MetaController],
  // 工单域实现作为 provider 注册，TicketsService 构造器注入（可独立 mock/override）。
  providers: [
    TicketsService,
    WorkflowService,
    TicketQueries,
    TicketEditor,
    TicketLifecycle,
    TicketMessaging,
    TicketParticipants,
    TicketDeletion,
  ],
})
export class TicketsModule {}
