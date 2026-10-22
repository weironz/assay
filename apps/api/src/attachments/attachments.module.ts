import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { AttachmentMaintenanceService } from './attachment-maintenance.service';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentMaintenanceService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
