import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PageQuery {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}
export class AssetQuery extends PageQuery {
  @IsOptional()
  @IsIn([
    'PENDING_REGISTRATION',
    'IN_STOCK',
    'IN_USE',
    'MAINTENANCE',
    'RETIRED',
  ])
  status?: string;
  @IsOptional() @IsString() departmentId?: string;
}
export class InventoryQuery extends PageQuery {
  @IsOptional() @IsString() sparePartId?: string;
  @IsOptional() @IsString() warehouseId?: string;
  @IsOptional() @IsString() assetId?: string;
  @IsOptional() @IsString() ticketId?: string;
}
export class AssetInput {
  @IsOptional() @IsString() @MaxLength(160) ownerName?: string;
  @IsOptional()
  @IsIn(['UNCONFIRMED', 'OWNED', 'LEASED', 'CUSTOMER'])
  ownership?: string;
  @IsOptional() @IsString() @MaxLength(100) rackName?: string;
  @IsOptional() @IsString() @MaxLength(30) rackUnit?: string;
  @IsOptional() @IsBoolean() labelVerified?: boolean;
  @IsOptional() @IsString() @Matches(/^GS-\d{6,9}$/) code?: string;
  @IsString() @Length(1, 160) name!: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(100) manufacturer?: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsOptional() @IsString() @MaxLength(160) serialNumber?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional()
  @IsIn([
    'PENDING_REGISTRATION',
    'IN_STOCK',
    'IN_USE',
    'MAINTENANCE',
    'RETIRED',
  ])
  status?: string;
  @IsOptional() @IsString() custodianId?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() datacenterId?: string;
  @IsOptional() @IsString() clusterId?: string;
  @IsOptional() @IsDateString() purchaseDate?: string;
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}(\.\d{1,2})?$/)
  purchaseCost?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsOptional() @IsDateString() warrantyUntil?: string;
}
export class PartInput {
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  sku!: string;
  @IsString() @Length(1, 160) name!: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(100) manufacturer?: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsString() @Length(1, 20) unit!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(100000000) minimumStock = 0;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class WarehouseInput {
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  code!: string;
  @IsString() @Length(1, 160) name!: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class DepartmentInput {
  @IsString() @Length(1, 100) name!: string;
  @IsOptional() @IsString() parentId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class MembershipInput {
  @IsOptional() @IsString() departmentId?: string;
}
export class TicketLinkInput {
  @IsString() @Length(1, 100) ticketId!: string;
}
export class InventoryInput {
  @IsIn(['RECEIVE', 'ISSUE', 'RETURN', 'TRANSFER', 'ADJUST', 'REVERSAL'])
  type!: string;
  @IsOptional() @IsString() sparePartId?: string;
  @IsOptional() @IsString() warehouseId?: string;
  @IsOptional() @IsString() destinationWarehouseId?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000000)
  quantity?: number;
  @IsString() @Length(1, 1000) reason!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{16,100}$/) idempotencyKey!: string;
  @IsOptional() @IsString() ticketId?: string;
  @IsOptional() @IsString() assetId?: string;
  @IsOptional() @IsString() reversesId?: string;
}

export class AssetImportRow {
  @IsString() @Length(1, 160) name!: string;
  @IsString() @Length(1, 100) site!: string;
  @IsOptional() @IsString() @Matches(/^GS-\d{6,9}$/) code?: string;
  @IsOptional() @IsString() @MaxLength(160) serialNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(100) manufacturer?: string;
  @IsOptional() @IsString() @MaxLength(120) model?: string;
  @IsOptional() @IsString() @MaxLength(100) rackName?: string;
  @IsOptional() @IsString() @MaxLength(30) rackUnit?: string;
  @IsOptional() @IsString() @MaxLength(60) sourceStatus?: string;
  @IsIn(['netbox', 'excel']) sourceSystem!: string;
  @IsString() @Length(1, 100) sourceRecordId!: string;
}
export class AssetImportInput {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AssetImportRow)
  rows!: AssetImportRow[];
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/) fingerprint?: string;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,100}$/)
  idempotencyKey?: string;
}
