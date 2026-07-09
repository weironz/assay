import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { WorkflowService } from './workflow.service';
import { MetaController } from './meta.controller';

@Module({
  controllers: [TicketsController, MetaController],
  providers: [TicketsService, WorkflowService],
})
export class TicketsModule {}
