import { Module } from '@nestjs/common';
import { TicketSharesController, PublicTicketSharesController } from './ticket-shares.controller';
import { TicketSharesService } from './ticket-shares.service';

@Module({
  controllers: [TicketSharesController, PublicTicketSharesController],
  providers: [TicketSharesService],
})
export class TicketSharesModule {}
