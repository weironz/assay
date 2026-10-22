import { Module } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';

const DONE = ['RESOLVED', 'CLOSED', 'CANCELLED'];
const STATUSES = [
  'NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING',
  'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED',
];

@Controller('stats')
class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  // 必须与 TicketsService.visibilityFilter 保持一致：本人提单/被指派的工单，
  // 以及被邀请为协作成员/关注者的工单，都要计入仪表盘统计。
  private scope(user: AuthUser): Prisma.TicketWhereInput {
    if (user.permissions.includes('ticket:read:all')) {
      return {};
    }
    return {
      OR: [
        { requesterId: user.id },
        { assigneeId: user.id },
        { participants: { some: { userId: user.id } } },
      ],
    };
  }

  @Get('overview')
  @RequirePermissions('ticket:read')
  async overview(@CurrentUser() user: AuthUser) {
    const base = this.scope(user);

    const grouped = await this.prisma.ticket.groupBy({
      by: ['status'],
      where: base,
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const s of STATUSES) byStatus[s] = 0;
    for (const g of grouped) byStatus[g.status] = g._count._all;

    const [total, myTodo, overdue, unassigned, unread] = await Promise.all([
      this.prisma.ticket.count({ where: base }),
      this.prisma.ticket.count({
        where: {
          assigneeId: user.id,
          status: { notIn: DONE as any },
        },
      }),
      this.prisma.ticket.count({
        where: {
          ...base,
          slaDueAt: { lt: new Date() },
          status: { notIn: [...DONE, 'PENDING'] as any },
        },
      }),
      this.prisma.ticket.count({
        where: { ...base, assigneeId: null, status: { notIn: DONE as any } },
      }),
      this.prisma.notification.count({
        where: { userId: user.id, isRead: false },
      }),
    ]);

    const open = STATUSES.filter((s) => !DONE.includes(s)).reduce(
      (sum, s) => sum + byStatus[s],
      0,
    );

    return { total, open, myTodo, overdue, unassigned, unread, byStatus };
  }
}

@Module({
  controllers: [StatsController],
})
export class StatsModule {}
