import { AssetImportService } from './import.service';
import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { AssetsService } from './assets.service';
import { InventoryService } from './inventory.service';
import { PlatformService } from './platform.service';
import { BusinessFilesService } from './files.service';
import { BusinessWriteGuard } from './business-write.guard';
@Module({
  controllers: [OperationsController],
  providers: [
    AssetImportService,
    AssetsService,
    InventoryService,
    PlatformService,
    BusinessFilesService,
    BusinessWriteGuard,
  ],
})
export class OperationsModule {}
