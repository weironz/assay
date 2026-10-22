import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssetStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  assetRelations,
  csv,
  databaseError,
  serializable,
  writeActivity,
} from './business';
import { AssetInput, AssetQuery } from './dto';
import { PlatformService } from './platform.service';
import { ticketVisibilityWhere } from '../tickets/visibility';

export const ASSET_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  PENDING_REGISTRATION: ['IN_STOCK', 'IN_USE', 'MAINTENANCE', 'RETIRED'],
  IN_STOCK: ['IN_USE', 'MAINTENANCE', 'RETIRED'],
  IN_USE: ['IN_STOCK', 'MAINTENANCE', 'RETIRED'],
  MAINTENANCE: ['IN_STOCK', 'IN_USE', 'RETIRED'],
  RETIRED: [],
};
@Injectable()
export class AssetsService {
  constructor(
    private readonly db: PrismaService,
    private readonly platform: PlatformService,
  ) {}
  private where(query: AssetQuery): Prisma.AssetWhereInput {
    const search = query.search?.trim();
    return {
      status: query.status as AssetStatus | undefined,
      departmentId: query.departmentId || undefined,
      ...(search
        ? {
            OR: [
              'code',
              'name',
              'serialNumber',
              'model',
              'location',
              'category',
            ].map((key) => ({
              [key]: { contains: search, mode: 'insensitive' },
            })),
          }
        : {}),
    };
  }
  async list(query: AssetQuery) {
    const where = this.where(query);
    const [items, total] = await Promise.all([
      this.db.asset.findMany({
        where,
        include: assetRelations,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.asset.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
  async get(user: AuthUser, id: string) {
    const asset = await this.db.asset.findUnique({
      where: { id },
      include: assetRelations,
    });
    if (!asset) throw new NotFoundException('资产不存在');
    return asset;
  }
  async save(user: AuthUser, dto: AssetInput, id?: string) {
    try {
      return await serializable(this.db, async (tx) => {
        const before = id ? await tx.asset.findUnique({ where: { id } }) : null;
        if (id && !before) throw new NotFoundException('资产不存在');
        if (before?.code && dto.code && before.code !== dto.code)
          throw new BadRequestException('资产编号不可更改');
        let code = before?.code;
        if (!code && (!id || dto.code)) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(73020261012::bigint)`;
          if (dto.code) {
            const number = Number(dto.code.slice(3));
            if (number < 1)
              throw new BadRequestException('资产流水号必须大于零');
            await tx.$executeRaw`SELECT setval('asset_number_sequence', GREATEST((SELECT last_value FROM asset_number_sequence), ${number}::bigint), true)`;
            code = dto.code;
          } else {
            const rows = await tx.$queryRaw<
              { number: bigint }[]
            >`SELECT nextval('asset_number_sequence') AS number`;
            code = 'GS-' + String(rows[0].number).padStart(6, '0');
          }
        }
        const status = (dto.status ??
          before?.status ??
          'PENDING_REGISTRATION') as AssetStatus;
        if (
          before &&
          before.status !== status &&
          !ASSET_TRANSITIONS[before.status].includes(status)
        )
          throw new BadRequestException('此资产状态不允许该流转');
        if (dto.labelVerified && !code)
          throw new BadRequestException('请先分配资产编号，再核对实物标签');
        if (
          !['PENDING_REGISTRATION', 'RETIRED'].includes(status) &&
          (!code || !dto.labelVerified)
        )
          throw new BadRequestException('请先完成资产发号和实物标签核对');
        if (status === 'IN_USE' && !dto.custodianId)
          throw new BadRequestException('在用资产必须指定责任人');
        if (
          dto.custodianId &&
          !(await tx.user.findFirst({
            where: { id: dto.custodianId, status: 'ACTIVE' },
          }))
        )
          throw new BadRequestException('责任人不存在或已停用');
        if (
          dto.departmentId &&
          !(await tx.department.findFirst({
            where: { id: dto.departmentId, active: true },
          }))
        )
          throw new BadRequestException('部门不存在或已停用');
        if (
          dto.datacenterId &&
          !(await tx.datacenter.findUnique({ where: { id: dto.datacenterId } }))
        )
          throw new BadRequestException('机房不存在');
        if (dto.clusterId) {
          const cluster = await tx.cluster.findUnique({
            where: { id: dto.clusterId },
          });
          if (
            !cluster ||
            (dto.datacenterId && cluster.datacenterId !== dto.datacenterId)
          )
            throw new BadRequestException('集群与机房不匹配');
        }
        if (
          dto.purchaseDate &&
          dto.warrantyUntil &&
          new Date(dto.warrantyUntil) < new Date(dto.purchaseDate)
        )
          throw new BadRequestException('保修截止不能早于采购日期');
        const data = {
          code: code!,
          ownerName: dto.ownerName?.trim() || null,
          ownership: dto.ownership ?? 'UNCONFIRMED',
          rackName: dto.rackName?.trim() || null,
          rackUnit: dto.rackUnit?.trim() || null,
          labelVerified: dto.labelVerified ?? false,
          name: dto.name.trim(),
          category: dto.category?.trim() || null,
          manufacturer: dto.manufacturer?.trim() || null,
          model: dto.model?.trim() || null,
          serialNumber: dto.serialNumber?.trim() || null,
          location: dto.location?.trim() || null,
          description: dto.description?.trim() || null,
          status,
          custodianId: dto.custodianId || null,
          departmentId: dto.departmentId || null,
          datacenterId: dto.datacenterId || null,
          clusterId: dto.clusterId || null,
          purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : null,
          purchaseCost: dto.purchaseCost
            ? new Prisma.Decimal(dto.purchaseCost)
            : null,
          currency: dto.currency ?? 'CNY',
          warrantyUntil: dto.warrantyUntil ? new Date(dto.warrantyUntil) : null,
        };
        if (!data.name) throw new BadRequestException('资产名称不能为空');
        const after = id
          ? await tx.asset.update({
              where: { id },
              data,
              include: assetRelations,
            })
          : await tx.asset.create({ data, include: assetRelations });
        await writeActivity(
          tx,
          user,
          'asset',
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
  async register(user: AuthUser, id: string) {
    return serializable(this.db, async (tx) => {
      const before = await tx.asset.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('资产不存在');
      if (before.code) return before;
      if (before.status === 'RETIRED')
        throw new BadRequestException('已退役资产不能发号');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73020261012::bigint)`;
      const rows = await tx.$queryRaw<
        { number: bigint }[]
      >`SELECT nextval('asset_number_sequence') AS number`;
      const after = await tx.asset.update({
        where: { id },
        data: { code: 'GS-' + String(rows[0].number).padStart(6, '0') },
      });
      await writeActivity(tx, user, 'asset', id, 'REGISTER', before, after);
      return after;
    });
  }
  async tickets(user: AuthUser, id: string) {
    await this.get(user, id);
    if (!user.permissions.includes('ticket:read')) return [];
    const scope = ticketVisibilityWhere(user);
    const links = await this.db.ticketAsset.findMany({
      where: { assetId: id, ticket: scope },
      include: {
        ticket: {
          select: { id: true, ticketNo: true, title: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return links.map((l) => l.ticket);
  }
  async link(user: AuthUser, id: string, ticketId: string, remove = false) {
    return serializable(this.db, async (tx) => {
      if (!(await tx.asset.findUnique({ where: { id } })))
        throw new NotFoundException('资产不存在');
      await this.platform.ticket(user, ticketId, tx);
      if (remove)
        await tx.ticketAsset.deleteMany({ where: { assetId: id, ticketId } });
      else
        await tx.ticketAsset.upsert({
          where: { ticketId_assetId: { ticketId, assetId: id } },
          update: {},
          create: { ticketId, assetId: id },
        });
      await writeActivity(
        tx,
        user,
        'asset',
        id,
        remove ? 'UNLINK_TICKET' : 'LINK_TICKET',
        undefined,
        { ticketId },
      );
      return { ok: true };
    });
  }
  async ticketAssets(user: AuthUser, ticketId: string) {
    await this.platform.ticket(user, ticketId);
    return this.db.ticketAsset
      .findMany({
        where: { ticketId },
        include: {
          asset: { select: { id: true, code: true, name: true, status: true } },
        },
      })
      .then((rows) => rows.map((row) => row.asset));
  }
  async export(query: AssetQuery) {
    const rows = await this.db.asset.findMany({
      where: this.where(query),
      include: assetRelations,
      orderBy: { code: 'asc' },
      take: 10001,
    });
    if (rows.length > 10000)
      throw new BadRequestException('导出超过 10000 条，请缩小筛选范围');
    return csv([
      [
        '资产编号',
        '名称',
        '分类',
        '序列号',
        '状态',
        '部门',
        '责任人',
        '位置',
        '采购金额',
        '币种',
      ],
      ...rows.map((r) => [
        r.code,
        r.name,
        r.category,
        r.serialNumber,
        r.status,
        r.department?.name,
        r.custodian?.name,
        r.location,
        r.purchaseCost,
        r.currency,
      ]),
    ]);
  }
}
