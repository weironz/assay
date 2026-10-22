import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryOperationType, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { csv, databaseError, serializable, writeActivity } from './business';
import {
  InventoryInput,
  InventoryQuery,
  PageQuery,
  PartInput,
  WarehouseInput,
} from './dto';
import { PlatformService } from './platform.service';
import { canViewTicket } from '../tickets/visibility';

const operationInclude = {
  sparePart: true,
  movements: { include: { warehouse: true } },
  asset: { select: { id: true, code: true, name: true } },
  reversedBy: { select: { id: true } },
  ticket: {
    select: {
      id: true,
      ticketNo: true,
      title: true,
      requesterId: true,
      assigneeId: true,
      participants: { select: { userId: true } },
    },
  },
} as const;
@Injectable()
export class InventoryService {
  constructor(
    private readonly db: PrismaService,
    private readonly platform: PlatformService,
  ) {}
  async parts(query: PageQuery) {
    const search = query.search?.trim();
    const where: Prisma.SparePartWhereInput = search
      ? {
          OR: ['sku', 'name', 'model', 'category'].map((key) => ({
            [key]: { contains: search, mode: 'insensitive' },
          })),
        }
      : {};
    const [items, total] = await Promise.all([
      this.db.sparePart.findMany({
        where,
        include: { balances: { include: { warehouse: true } } },
        orderBy: { sku: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.sparePart.count({ where }),
    ]);
    return {
      items: items.map((p) => ({
        ...p,
        totalQuantity: p.balances.reduce((sum, b) => sum + b.quantity, 0),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async part(id: string) {
    const part = await this.db.sparePart.findUnique({
      where: { id },
      include: { balances: { include: { warehouse: true } } },
    });
    if (!part) throw new NotFoundException('备件不存在');
    return {
      ...part,
      totalQuantity: part.balances.reduce((sum, b) => sum + b.quantity, 0),
    };
  }
  async savePart(user: AuthUser, dto: PartInput, id?: string) {
    try {
      return await serializable(this.db, async (tx) => {
        const before = id
          ? await tx.sparePart.findUnique({ where: { id } })
          : null;
        if (id && !before) throw new NotFoundException('备件不存在');
        if (
          id &&
          dto.active === false &&
          (await tx.stockBalance.count({
            where: { sparePartId: id, quantity: { gt: 0 } },
          }))
        )
          throw new BadRequestException('请先清空此备件的库存再停用');
        const data = {
          sku: dto.sku.trim().toUpperCase(),
          name: dto.name.trim(),
          unit: dto.unit.trim(),
          minimumStock: dto.minimumStock,
          category: dto.category?.trim() || null,
          manufacturer: dto.manufacturer?.trim() || null,
          model: dto.model?.trim() || null,
          description: dto.description?.trim() || null,
          active: dto.active ?? true,
        };
        if (!data.name || !data.unit)
          throw new BadRequestException('名称和单位不能为空');
        const after = id
          ? await tx.sparePart.update({ where: { id }, data })
          : await tx.sparePart.create({ data });
        await writeActivity(
          tx,
          user,
          'spare_part',
          after.id,
          id ? 'UPDATE' : 'CREATE',
          before,
          after,
        );
        return after;
      });
    } catch (error) {
      databaseError(error);
    }
  }
  warehouses() {
    return this.db.warehouse.findMany({
      include: { department: true },
      orderBy: { code: 'asc' },
    });
  }
  async saveWarehouse(user: AuthUser, dto: WarehouseInput, id?: string) {
    try {
      return await serializable(this.db, async (tx) => {
        const before = id
          ? await tx.warehouse.findUnique({ where: { id } })
          : null;
        if (id && !before) throw new NotFoundException('仓库不存在');
        if (
          id &&
          dto.active === false &&
          (await tx.stockBalance.count({
            where: { warehouseId: id, quantity: { gt: 0 } },
          }))
        )
          throw new BadRequestException('仓库还有库存，不能停用');
        if (
          dto.departmentId &&
          !(await tx.department.findFirst({
            where: { id: dto.departmentId, active: true },
          }))
        )
          throw new BadRequestException('部门不存在或已停用');
        const data = {
          code: dto.code.trim().toUpperCase(),
          name: dto.name.trim(),
          location: dto.location?.trim() || null,
          departmentId: dto.departmentId || null,
          active: dto.active ?? true,
        };
        if (!data.name) throw new BadRequestException('仓库名称不能为空');
        const after = id
          ? await tx.warehouse.update({ where: { id }, data })
          : await tx.warehouse.create({ data });
        await writeActivity(
          tx,
          user,
          'warehouse',
          after.id,
          id ? 'UPDATE' : 'CREATE',
          before,
          after,
        );
        return after;
      });
    } catch (error) {
      databaseError(error);
    }
  }
  private visibleOperation(user: AuthUser, operation: any) {
    const t = operation.ticket;
    const visible =
      t &&
      user.permissions.includes('ticket:read') &&
      canViewTicket(user, t);
    return {
      ...operation,
      ticketId: visible ? t.id : null,
      ticket: visible
        ? { id: t.id, ticketNo: t.ticketNo, title: t.title }
        : null,
      requestHash: undefined,
      idempotencyKey: undefined,
    };
  }
  private where(q: InventoryQuery): Prisma.InventoryOperationWhereInput {
    return {
      sparePartId: q.sparePartId || undefined,
      assetId: q.assetId || undefined,
      ticketId: q.ticketId || undefined,
      ...(q.warehouseId
        ? { movements: { some: { warehouseId: q.warehouseId } } }
        : {}),
      ...(q.search?.trim()
        ? { reason: { contains: q.search.trim(), mode: 'insensitive' } }
        : {}),
    };
  }
  async operations(user: AuthUser, q: InventoryQuery) {
    // Filtering by an inaccessible ticket must not become a lookup side channel.
    if (q.ticketId) await this.platform.ticket(user, q.ticketId);
    const where = this.where(q);
    const [items, total] = await Promise.all([
      this.db.inventoryOperation.findMany({
        where,
        include: operationInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.db.inventoryOperation.count({ where }),
    ]);
    return {
      items: items.map((op) => this.visibleOperation(user, op)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
  async balances(q: InventoryQuery) {
    const where: Prisma.StockBalanceWhereInput = {
      warehouseId: q.warehouseId || undefined,
      sparePartId: q.sparePartId || undefined,
      ...(q.search?.trim()
        ? {
            sparePart: {
              OR: [
                { sku: { contains: q.search.trim(), mode: 'insensitive' } },
                { name: { contains: q.search.trim(), mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.stockBalance.findMany({
        where,
        include: { warehouse: true, sparePart: true },
        orderBy: [{ warehouseId: 'asc' }, { sparePartId: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.db.stockBalance.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
  async post(user: AuthUser, dto: InventoryInput) {
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('必须填写业务原因');
    // Canonical normalized payload makes idempotency stable regardless of object key order.
    const request = {
      actorId: user.id,
      type: dto.type,
      sparePartId: dto.sparePartId || null,
      warehouseId: dto.warehouseId || null,
      destinationWarehouseId: dto.destinationWarehouseId || null,
      quantity: dto.quantity ?? null,
      reason,
      ticketId: dto.ticketId || null,
      assetId: dto.assetId || null,
      reversesId: dto.reversesId || null,
    };
    const hash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const replay = (op: any) => {
      if (op.requestHash !== hash)
        throw new ConflictException('幂等键已用于其他请求');
      return this.visibleOperation(user, op);
    };
    const existing = await this.db.inventoryOperation.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      include: operationInclude,
    });
    if (existing) return replay(existing);
    try {
      const operation = await serializable(this.db, async (tx) => {
        const repeated = await tx.inventoryOperation.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: operationInclude,
        });
        if (repeated) {
          if (repeated.requestHash !== hash)
            throw new ConflictException('幂等键已用于其他请求');
          return repeated;
        }
        const original =
          dto.type === 'REVERSAL' && dto.reversesId
            ? await tx.inventoryOperation.findUnique({
                where: { id: dto.reversesId },
                include: { movements: true, reversedBy: true },
              })
            : null;
        if (
          dto.type === 'REVERSAL' &&
          (!original || original.type === 'REVERSAL' || original.reversedBy)
        )
          throw new BadRequestException(
            '原操作不存在或已被冲销，冲销单不能再次冲销',
          );
        if (dto.type !== 'REVERSAL' && dto.reversesId)
          throw new BadRequestException('仅冲销操作可指定原操作');
        const sparePartId = original?.sparePartId || dto.sparePartId;
        const part = sparePartId
          ? await tx.sparePart.findUnique({ where: { id: sparePartId } })
          : null;
        if (!part || !part.active)
          throw new BadRequestException('备件不存在或已停用');
        const ticketId = original?.ticketId || dto.ticketId || null,
          assetId = original?.assetId || dto.assetId || null;
        if (ticketId && !original)
          await this.platform.ticket(user, ticketId, tx);
        if (assetId) {
          const asset = await tx.asset.findUnique({ where: { id: assetId } });
          if (!asset || (dto.type === 'ISSUE' && asset.status === 'RETIRED'))
            throw new BadRequestException('资产不存在，或退役资产不能领用备件');
        }
        let changes: { warehouseId: string; delta: number }[] = [];
        if (original)
          changes = original.movements.map((m) => ({
            warehouseId: m.warehouseId,
            delta: -m.delta,
          }));
        else {
          if (!dto.warehouseId || !Number.isInteger(dto.quantity))
            throw new BadRequestException('必须指定仓库和整数数量');
          const quantity = dto.quantity!;
          if (dto.type !== 'ADJUST' && quantity < 1)
            throw new BadRequestException('数量必须大于零');
          if (dto.type === 'TRANSFER') {
            if (
              !dto.destinationWarehouseId ||
              dto.destinationWarehouseId === dto.warehouseId
            )
              throw new BadRequestException('调拨需指定不同的目标仓库');
            changes = [
              { warehouseId: dto.warehouseId, delta: -quantity },
              { warehouseId: dto.destinationWarehouseId, delta: quantity },
            ];
          } else if (dto.type === 'ADJUST') {
            const before = await tx.stockBalance.findUnique({
              where: {
                warehouseId_sparePartId: {
                  warehouseId: dto.warehouseId,
                  sparePartId: part.id,
                },
              },
            });
            const delta = quantity - (before?.quantity ?? 0);
            if (!delta)
              throw new BadRequestException('盘点数量与账面一致，无需调整');
            changes = [{ warehouseId: dto.warehouseId, delta }];
          } else
            changes = [
              {
                warehouseId: dto.warehouseId,
                delta: dto.type === 'ISSUE' ? -quantity : quantity,
              },
            ];
        }
        // Stable order reduces deadlocks when simultaneous transfers reverse direction.
        changes.sort((a, b) => a.warehouseId.localeCompare(b.warehouseId));
        const created = await tx.inventoryOperation.create({
          data: {
            type: dto.type as InventoryOperationType,
            sparePartId: part.id,
            actorId: user.id,
            actorName: user.name,
            idempotencyKey: dto.idempotencyKey,
            requestHash: hash,
            reason,
            ticketId,
            assetId,
            reversesId: original?.id,
          },
        });
        for (const change of changes) {
          if (
            !(await tx.warehouse.findFirst({
              where: { id: change.warehouseId, active: true },
            }))
          )
            throw new BadRequestException('仓库不存在或已停用');
          const key = { warehouseId: change.warehouseId, sparePartId: part.id };
          const balance = await tx.stockBalance.upsert({
            where: { warehouseId_sparePartId: key },
            update: {},
            create: key,
          });
          const after = balance.quantity + change.delta;
          if (after < 0) throw new ConflictException('库存不足，操作未提交');
          if (after > 2000000000)
            throw new BadRequestException('库存数量超过支持范围');
          const changed = await tx.stockBalance.updateMany({
            where: { ...key, quantity: balance.quantity },
            data: { quantity: after },
          });
          if (changed.count !== 1)
            throw new ConflictException('库存已变化，请重试');
          await tx.stockMovement.create({
            data: {
              operationId: created.id,
              ...key,
              delta: change.delta,
              before: balance.quantity,
              after,
            },
          });
        }
        await writeActivity(
          tx,
          user,
          'inventory_operation',
          created.id,
          'POST',
          undefined,
          { type: created.type, sparePartId: part.id, changes, reason },
        );
        await writeActivity(
          tx,
          user,
          'spare_part',
          part.id,
          'STOCK_' + dto.type,
          undefined,
          { operationId: created.id, changes, reason },
        );
        return tx.inventoryOperation.findUniqueOrThrow({
          where: { id: created.id },
          include: operationInclude,
        });
      });
      return this.visibleOperation(user, operation);
    } catch (error: any) {
      if (error.code === 'P2002') {
        const committed = await this.db.inventoryOperation.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: operationInclude,
        });
        if (committed) return replay(committed);
        throw new ConflictException(
          '原操作已被冲销或并发操作冲突，请刷新后重试',
        );
      }
      databaseError(error);
    }
  }
  async export(user: AuthUser, q: InventoryQuery) {
    if (q.ticketId) await this.platform.ticket(user, q.ticketId);
    const rows = await this.db.inventoryOperation.findMany({
      where: this.where(q),
      include: operationInclude,
      orderBy: { createdAt: 'desc' },
      take: 10001,
    });
    if (rows.length > 10000)
      throw new BadRequestException('导出超过 10000 条，请缩小筛选范围');
    return csv([
      [
        '操作编号',
        '类型',
        'SKU',
        '备件',
        '仓库',
        '变动',
        '操作前',
        '操作后',
        '操作人',
        '原因',
        '时间',
      ],
      ...rows.flatMap((r) =>
        r.movements.map((m) => [
          r.id,
          r.type,
          r.sparePart.sku,
          r.sparePart.name,
          m.warehouse.name,
          m.delta,
          m.before,
          m.after,
          r.actorName,
          r.reason,
          r.createdAt.toISOString(),
        ]),
      ),
    ]);
  }
}
