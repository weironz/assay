import { AssetImportService } from './import.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import type { Response } from 'express';
import { MAX_ATTACHMENT_BYTES, UPLOAD_TMP_DIR } from '../attachments/limits';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { AssetsService } from './assets.service';
import { InventoryService } from './inventory.service';
import { PlatformService } from './platform.service';
import { BusinessFilesService } from './files.service';
import { BusinessWriteGuard } from './business-write.guard';
import {
  AssetImportInput,
  AssetInput,
  AssetQuery,
  DepartmentInput,
  InventoryInput,
  InventoryQuery,
  MembershipInput,
  PageQuery,
  PartInput,
  TicketLinkInput,
  WarehouseInput,
} from './dto';
const attachmentUpload = {
  storage: diskStorage({ destination: UPLOAD_TMP_DIR || tmpdir() }),
  limits: { fileSize: MAX_ATTACHMENT_BYTES + 1 },
};
function downloadCSV(res: Response, name: string, contents: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  res.send(contents);
}

@Controller()
export class OperationsController {
  constructor(
    private readonly importer: AssetImportService,
    private readonly assets: AssetsService,
    private readonly inventory: InventoryService,
    private readonly platform: PlatformService,
    private readonly files: BusinessFilesService,
  ) {}
  @Get('platform/overview') overview(@CurrentUser() u: AuthUser) {
    return this.platform.overview(u);
  }
  @Get('platform/options') @RequirePermissions('platform:directory') options() {
    return this.platform.options();
  }
  @Get('departments') @RequirePermissions('organization:manage') departments() {
    return this.platform.departments();
  }
  @Get('departments/members')
  @RequirePermissions('organization:manage')
  members() {
    return this.platform.members();
  }
  @Post('departments') @RequirePermissions('organization:manage') department(
    @CurrentUser() u: AuthUser,
    @Body() d: DepartmentInput,
  ) {
    return this.platform.department(u, d);
  }
  @Put('departments/:id')
  @RequirePermissions('organization:manage')
  updateDepartment(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() d: DepartmentInput,
  ) {
    return this.platform.department(u, d, id);
  }
  @Patch('departments/members/:id')
  @RequirePermissions('organization:manage')
  membership(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() d: MembershipInput,
  ) {
    return this.platform.membership(u, id, d.departmentId);
  }
  @Get('assets') @RequirePermissions('asset:read') listAssets(
    @Query() q: AssetQuery,
  ) {
    return this.assets.list(q);
  }
  @Get('assets/export') @RequirePermissions('asset:read') async exportAssets(
    @Query() q: AssetQuery,
    @Res() r: Response,
  ) {
    downloadCSV(r, 'assets.csv', await this.assets.export(q));
  }
  @Post('assets/import/preview')
  @RequirePermissions('asset:manage')
  previewImport(@Body() d: AssetImportInput) {
    return this.importer.preview(d);
  }
  @Post('assets/import/commit')
  @RequirePermissions('asset:manage')
  commitImport(@CurrentUser() u: AuthUser, @Body() d: AssetImportInput) {
    return this.importer.commit(u, d);
  }
  @Get('assets/import/netbox') @RequirePermissions('asset:manage') netbox() {
    return this.importer.netbox();
  }
  @Get('assets/:id') @RequirePermissions('asset:read') asset(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
  ) {
    return this.assets.get(u, id);
  }
  @Post('assets') @RequirePermissions('asset:manage') newAsset(
    @CurrentUser() u: AuthUser,
    @Body() d: AssetInput,
  ) {
    return this.assets.save(u, d);
  }
  @Put('assets/:id') @RequirePermissions('asset:manage') updateAsset(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() d: AssetInput,
  ) {
    return this.assets.save(u, d, id);
  }
  @Post('assets/:id/register') @RequirePermissions('asset:manage') register(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
  ) {
    return this.assets.register(u, id);
  }
  @Get('assets/:id/tickets') @RequirePermissions('asset:read') assetTickets(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
  ) {
    return this.assets.tickets(u, id);
  }
  @Post('assets/:id/tickets')
  @RequirePermissions('asset:manage', 'ticket:read')
  link(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() d: TicketLinkInput,
  ) {
    return this.assets.link(u, id, d.ticketId);
  }
  @Delete('assets/:id/tickets/:ticketId')
  @RequirePermissions('asset:manage', 'ticket:read')
  unlink(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Param('ticketId') ticketId: string,
  ) {
    return this.assets.link(u, id, ticketId, true);
  }
  @Get('tickets/:id/assets') @RequirePermissions('ticket:read') ticketAssets(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
  ) {
    return this.assets.ticketAssets(u, id);
  }
  @Get('spare-parts') @RequirePermissions('inventory:read') parts(
    @Query() q: PageQuery,
  ) {
    return this.inventory.parts(q);
  }
  @Get('spare-parts/:id') @RequirePermissions('inventory:read') part(
    @Param('id') id: string,
  ) {
    return this.inventory.part(id);
  }
  @Post('spare-parts') @RequirePermissions('inventory:manage') newPart(
    @CurrentUser() u: AuthUser,
    @Body() d: PartInput,
  ) {
    return this.inventory.savePart(u, d);
  }
  @Put('spare-parts/:id') @RequirePermissions('inventory:manage') updatePart(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() d: PartInput,
  ) {
    return this.inventory.savePart(u, d, id);
  }
  @Get('warehouses') @RequirePermissions('inventory:read') warehouses() {
    return this.inventory.warehouses();
  }
  @Post('warehouses') @RequirePermissions('inventory:manage') warehouse(
    @CurrentUser() u: AuthUser,
    @Body() d: WarehouseInput,
  ) {
    return this.inventory.saveWarehouse(u, d);
  }
  @Put('warehouses/:id')
  @RequirePermissions('inventory:manage')
  updateWarehouse(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() d: WarehouseInput,
  ) {
    return this.inventory.saveWarehouse(u, d, id);
  }
  @Get('inventory/balances') @RequirePermissions('inventory:read') balances(
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.balances(q);
  }
  @Get('inventory/operations') @RequirePermissions('inventory:read') operations(
    @CurrentUser() u: AuthUser,
    @Query() q: InventoryQuery,
  ) {
    return this.inventory.operations(u, q);
  }
  @Get('inventory/export')
  @RequirePermissions('inventory:read')
  async exportInventory(
    @CurrentUser() u: AuthUser,
    @Query() q: InventoryQuery,
    @Res() r: Response,
  ) {
    downloadCSV(r, 'inventory.csv', await this.inventory.export(u, q));
  }
  @Post('inventory/operations')
  @RequirePermissions('inventory:manage')
  postInventory(@CurrentUser() u: AuthUser, @Body() d: InventoryInput) {
    return this.inventory.post(u, d);
  }
  @Get('operations/:kind/:id/activity') activity(
    @CurrentUser() u: AuthUser,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ) {
    return this.platform.activity(u, kind, id);
  }
  @Get('operations/:kind/:id/attachments') attachments(
    @CurrentUser() u: AuthUser,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ) {
    return this.files.list(u, kind, id);
  }
  @Post('operations/:kind/:id/attachments')
  @UseGuards(BusinessWriteGuard)
  @UseInterceptors(FileInterceptor('file', attachmentUpload))
  upload(
    @CurrentUser() u: AuthUser,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @UploadedFile() f: Express.Multer.File,
  ) {
    return this.files.upload(u, kind, id, f);
  }
  @Get('operations/attachments/:id/download') async download(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Res() r: Response,
  ) {
    const { record, stream } = await this.files.download(u, id);
    r.setHeader('Content-Type', 'application/octet-stream');
    r.setHeader('X-Content-Type-Options', 'nosniff');
    r.setHeader('Content-Length', String(record.fileSize));
    r.setHeader(
      'Content-Disposition',
      "attachment; filename*=UTF-8''" + encodeURIComponent(record.fileName),
    );
    r.on('close', () => stream.destroy());
    stream.on('error', () => r.destroy());
    stream.pipe(r);
  }
}
