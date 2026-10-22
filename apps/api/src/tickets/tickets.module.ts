import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { WorkflowService } from './workflow.service';
import { MetaController } from './meta.controller';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [AttachmentsModule],
  controllers: [TicketsController, MetaController],
  providers: [TicketsService, WorkflowService],
})
export class TicketsModule {}
