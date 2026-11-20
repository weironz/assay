import { Controller, Get, Module } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { ticketVisibilityWhere } from '../tickets/visibility';
import { TERMINAL_STATUSES } from '../tickets/core';

const STATUSES = Object.values(TicketStatus);

@Controller('stats')
class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  @RequirePermissions('ticket:read')
  async overview(@CurrentUser() user: AuthUser) {
    const base = ticketVisibilityWhere(user);

    const [grouped, myTodo, overdue, unassigned, unread] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      this.prisma.ticket.count({
        where: {
          ...base,
          assigneeId: user.id,
          status: { notIn: TERMINAL_STATUSES },
        },
      }),
      this.prisma.ticket.count({
        where: {
          ...base,
          slaDueAt: { lt: new Date() },
          status: { notIn: [...TERMINAL_STATUSES, 'PENDING'] },
        },
      }),
      this.prisma.ticket.count({
        where: { ...base, assigneeId: null, status: { notIn: TERMINAL_STATUSES } },
      }),
      this.prisma.notification.count({
        where: { userId: user.id, isRead: false },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const s of STATUSES) byStatus[s] = 0;
    for (const g of grouped) byStatus[g.status] = g._count._all;
    const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
    const open = STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s)).reduce(
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
