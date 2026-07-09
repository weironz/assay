import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SlaService, SLA_QUEUE } from './sla.service';
import { SlaProcessor } from './sla.processor';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: SLA_QUEUE })],
  providers: [SlaService, SlaProcessor],
  exports: [SlaService],
})
export class SlaModule {}
