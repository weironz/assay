import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { canManageParticipants } from './visibility';
import { PARTICIPANT_USER_SELECT, writeHistory } from './core';
import { AddParticipantDto } from './dto';

/**
 * 协作成员/关注人域。注册为 TicketsModule provider，由 TicketsService 构造器注入并委派。
 */
@Injectable()
export class TicketParticipants {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async loadManageable(user: AuthUser, id: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (!canManageParticipants(user, ticket)) {
      throw new ForbiddenException('仅主处理人、主管或管理员可管理协作成员');
    }
    return ticket;
  }

  async participantCandidates(user: AuthUser, id: string) {
    await this.loadManageable(user, id);
    return this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      select: PARTICIPANT_USER_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async addParticipant(user: AuthUser, id: string, dto: AddParticipantDto) {
    const ticket = await this.loadManageable(user, id);
    if (dto.userId === ticket.requesterId || dto.userId === ticket.assigneeId) {
      throw new BadRequestException('提单人和主处理人已自动拥有工单访问权限');
    }
    const participant = await this.prisma.user.findFirst({
      where: { id: dto.userId, status: 'ACTIVE' },
    });
    if (!participant) throw new BadRequestException('协作对象不存在或已禁用');
    const result = await this.prisma.ticketParticipant.upsert({
      where: { ticketId_userId: { ticketId: id, userId: dto.userId } },
      update: { role: dto.role, addedById: user.id },
      create: { ticketId: id, userId: dto.userId, role: dto.role, addedById: user.id },
      include: { user: { select: PARTICIPANT_USER_SELECT } },
    });
    await writeHistory(this.prisma, id, user.id, 'UPDATE', 'participant', null, `${dto.role}:${dto.userId}`);
    await this.notifications.notify(dto.userId, {
      type: 'ASSIGNED',
      title:
        dto.role === 'COLLABORATOR'
          ? `你已加入工单协作：${ticket.ticketNo}`
          : `你正在关注工单：${ticket.ticketNo}`,
      content: ticket.title,
      ticketId: id,
    });
    return result;
  }

  async removeParticipant(user: AuthUser, id: string, userId: string) {
    await this.loadManageable(user, id);
    await this.prisma.ticketParticipant.deleteMany({ where: { ticketId: id, userId } });
    await writeHistory(this.prisma, id, user.id, 'UPDATE', 'participant', userId, null);
    return { ok: true };
  }
}
