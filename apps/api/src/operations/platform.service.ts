import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import {
  adapter,
  serializable,
  writeActivity,
  databaseError,
  requirePermission,
} from './business';
import { DepartmentInput } from './dto';

@Injectable()
export class PlatformService {
  constructor(private readonly db: PrismaService) {}
  async subject(user: AuthUser, kind: string, id: string, write = false) {
    const policy = adapter(kind);
    requirePermission(user, write ? policy.write : policy.read);
    const record = await (this.db[policy.model] as any).findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('业务对象不存在');
    return record;
  }
  async ticket(user: AuthUser, id: string, db: any = this.db) {
    requirePermission(user, 'ticket:read');
    const ticket = await db.ticket.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (
      !user.permissions.includes('ticket:read:all') &&
      ticket.requesterId !== user.id &&
      ticket.assigneeId !== user.id &&
      !ticket.participants.some((p: any) => p.userId === user.id)
    ) {
      throw new ForbiddenException('无权关联或查看此工单');
    }
    return ticket;
  }
  async options() {
    const [users, departments, datacenters, clusters] = await Promise.all([
      this.db.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, departmentId: true },
        orderBy: { name: 'asc' },
      }),
      this.db.department.findMany({ orderBy: { name: 'asc' } }),
      this.db.datacenter.findMany(),
      this.db.cluster.findMany(),
    ]);
    return { users, departments, datacenters, clusters };
  }
  async overview(user: AuthUser) {
    const assets = user.permissions.includes('asset:read')
      ? await this.db.asset.groupBy({ by: ['status'], _count: { _all: true } })
      : [];
    if (!user.permissions.includes('inventory:read')) return { assets };
    const [parts, warehouses, operations, lowStock] = await Promise.all([
      this.db.sparePart.count({ where: { active: true } }),
      this.db.warehouse.count({ where: { active: true } }),
      this.db.inventoryOperation.count(),
      this.db.$queryRaw<
        {
          id: string;
          sku: string;
          name: string;
          quantity: bigint;
          minimumStock: number;
        }[]
      >`
      SELECT p.id,p.sku,p.name,p."minimumStock",COALESCE(SUM(b.quantity),0)::bigint AS quantity
      FROM spare_parts p LEFT JOIN stock_balances b ON b."sparePartId"=p.id
      WHERE p.active=true GROUP BY p.id HAVING COALESCE(SUM(b.quantity),0)<p."minimumStock"
      ORDER BY p.sku LIMIT 20`,
    ]);
    return {
      assets,
      parts,
      warehouses,
      operations,
      lowStock: lowStock.map((r) => ({ ...r, quantity: Number(r.quantity) })),
    };
  }
  departments() {
    return this.db.department.findMany({
      include: {
        _count: { select: { users: true, assets: true, warehouses: true } },
      },
      orderBy: { name: 'asc' },
    });
  }
  members() {
    return this.db.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        departmentId: true,
        status: true,
      },
      orderBy: { name: 'asc' },
    });
  }
  async department(user: AuthUser, dto: DepartmentInput, id?: string) {
    try {
      return await serializable(this.db, async (tx) => {
        const before = id
          ? await tx.department.findUnique({ where: { id } })
          : null;
        if (id && !before) throw new NotFoundException('部门不存在');
        let parent = dto.parentId || null;
        const seen = new Set<string>();
        while (parent) {
          if (parent === id || seen.has(parent))
            throw new BadRequestException('部门层级不能形成循环');
          seen.add(parent);
          const record = await tx.department.findUnique({
            where: { id: parent },
          });
          if (!record || !record.active)
            throw new BadRequestException('上级部门不存在或已停用');
          parent = record.parentId;
        }
        if (
          dto.active === false &&
          id &&
          (await tx.department.count({ where: { parentId: id, active: true } }))
        ) {
          throw new BadRequestException('请先调整或停用下级部门');
        }
        const data = {
          name: dto.name.trim(),
          parentId: dto.parentId || null,
          active: dto.active ?? true,
        };
        if (!data.name) throw new BadRequestException('部门名称不能为空');
        const after = id
          ? await tx.department.update({ where: { id }, data })
          : await tx.department.create({ data });
        await writeActivity(
          tx,
          user,
          'department',
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
  async membership(user: AuthUser, id: string, departmentId?: string) {
    return serializable(this.db, async (tx) => {
      if (
        departmentId &&
        !(await tx.department.findFirst({
          where: { id: departmentId, active: true },
        }))
      )
        throw new BadRequestException('部门不存在或已停用');
      const before = await tx.user.findUnique({
        where: { id },
        select: { id: true, name: true, departmentId: true },
      });
      if (!before) throw new NotFoundException('用户不存在');
      const after = await tx.user.update({
        where: { id },
        data: { departmentId: departmentId || null },
        select: { id: true, name: true, departmentId: true },
      });
      if (before.departmentId)
        await writeActivity(
          tx,
          user,
          'department',
          before.departmentId,
          'MEMBER_CHANGED',
          before,
          after,
        );
      if (after.departmentId && before.departmentId !== after.departmentId)
        await writeActivity(
          tx,
          user,
          'department',
          after.departmentId,
          'MEMBER_CHANGED',
          before,
          after,
        );
      return after;
    });
  }
  async activity(user: AuthUser, kind: string, id: string) {
    await this.subject(user, kind, id);
    const entries = await this.db.businessActivity.findMany({
      where: { kind, entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // LINK/UNLINK 条目需按工单可见性脱敏。工单 id 去重后一次查询探测，
    // 替代逐条 this.ticket()（每条都是带 participants include 的独立查询）。
    const linkedTicketIds = [
      ...new Set(
        entries.flatMap((entry) => {
          if (!['LINK_TICKET', 'UNLINK_TICKET'].includes(entry.action))
            return [];
          const ticketId = (entry.after as { ticketId?: string } | null)
            ?.ticketId;
          return ticketId ? [ticketId] : [];
        }),
      ),
    ];
    const hidden = new Set<string>();
    if (linkedTicketIds.length) {
      requirePermission(user, 'ticket:read');
      const readAll = user.permissions.includes('ticket:read:all');
      const tickets = await this.db.ticket.findMany({
        where: { id: { in: linkedTicketIds } },
        select: {
          id: true,
          requesterId: true,
          assigneeId: true,
          participants: { select: { userId: true } },
        },
      });
      const visible = new Set(
        (readAll
          ? tickets
          : tickets.filter(
              (t) =>
                t.requesterId === user.id ||
                t.assigneeId === user.id ||
                t.participants.some((p) => p.userId === user.id),
            )
        ).map((t) => t.id),
      );
      for (const ticketId of linkedTicketIds)
        if (!visible.has(ticketId)) hidden.add(ticketId);
    }
    return entries.map((entry) => {
      if (!['LINK_TICKET', 'UNLINK_TICKET'].includes(entry.action))
        return entry;
      const ticketId = (entry.after as { ticketId?: string } | null)?.ticketId;
      if (!ticketId || !hidden.has(ticketId)) return entry;
      return { ...entry, after: { ticketHidden: true } };
    });
  }
}
