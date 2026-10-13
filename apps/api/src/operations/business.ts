import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';

export const BUSINESS_ADAPTERS = {
  import_batch: {
    model: 'assetImportBatch',
    read: 'asset:manage',
    write: 'asset:manage',
    path: '/assets/import',
  },
  asset: {
    model: 'asset',
    read: 'asset:read',
    write: 'asset:manage',
    path: '/assets/',
  },
  spare_part: {
    model: 'sparePart',
    read: 'inventory:read',
    write: 'inventory:manage',
    path: '/spare-parts/',
  },
  warehouse: {
    model: 'warehouse',
    read: 'inventory:read',
    write: 'inventory:manage',
    path: '/inventory',
  },
  inventory_operation: {
    model: 'inventoryOperation',
    read: 'inventory:read',
    write: 'inventory:manage',
    path: '/inventory',
  },
  department: {
    model: 'department',
    read: 'organization:manage',
    write: 'organization:manage',
    path: '/organization',
  },
} as const;
export type BusinessKind = keyof typeof BUSINESS_ADAPTERS;
export interface BusinessRef {
  kind: BusinessKind;
  id: string;
}

// Future leave/expense modules register their own access adapter and typed model.
// Approval lifecycle is independent from the referenced business state.
export interface ApprovalAdapter {
  subject: BusinessRef;
  definitionVersion: string;
  submit(actor: AuthUser): Promise<void>;
  approve(actor: AuthUser, comment: string): Promise<void>;
  reject(actor: AuthUser, comment: string): Promise<void>;
  withdraw(actor: AuthUser, comment: string): Promise<void>;
}
export function adapter(kind: string) {
  if (!Object.prototype.hasOwnProperty.call(BUSINESS_ADAPTERS, kind))
    throw new BadRequestException('未知业务类型');
  return BUSINESS_ADAPTERS[kind as BusinessKind];
}
export function requirePermission(user: AuthUser, permission: string) {
  if (!user.permissions.includes(permission))
    throw new ForbiddenException('缺少权限: ' + permission);
}
export async function writeActivity(
  db: Prisma.TransactionClient,
  user: AuthUser,
  kind: BusinessKind,
  entityId: string,
  action: string,
  before?: unknown,
  after?: unknown,
) {
  // Snapshot values are JSON-safe (dates/decimal), never runtime credentials.
  const json = (value: unknown) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return db.businessActivity.create({
    data: {
      kind,
      entityId,
      action,
      actorId: user.id,
      actorName: user.name,
      before: json(before),
      after: json(after),
    },
  });
}
export async function serializable<T>(
  db: any,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      });
    } catch (error: any) {
      if (error.code !== 'P2034') throw error;
      if (attempt === 4)
        throw new ConflictException('并发操作冲突，请稍后重试');
    }
  }
  throw new ConflictException();
}
export function databaseError(error: any): never {
  if (error.code === 'P2002') throw new ConflictException('编号或名称已存在');
  if (error.code === 'P2003')
    throw new BadRequestException('关联对象不存在或仍被引用');
  if (error.code === 'P2025') throw new BadRequestException('对象不存在');
  throw error;
}
export function csv(rows: unknown[][]) {
  const cell = (v: unknown) => {
    let value = String(v ?? '');
    // Prevent spreadsheet formula execution when operators open exported files.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(value))
      value = "'" + value;
    return '"' + value.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
}
export const assetRelations = {
  custodian: { select: { id: true, name: true } },
  department: true,
  datacenter: true,
  cluster: true,
} as const;
