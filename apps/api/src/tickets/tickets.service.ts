import { Injectable } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { TicketAction } from './workflow.service';
import { TicketQueries } from './ticket-queries';
import { TicketEditor } from './ticket-editor';
import { TicketLifecycle } from './ticket-lifecycle';
import { TicketMessaging } from './ticket-messaging';
import { TicketParticipants } from './ticket-participants';
import { TicketDeletion } from './ticket-deletion';
import {
  AddParticipantDto,
  AssignDto,
  CreateMessageDto,
  CreateTicketDto,
  ListTicketsQuery,
  UpdateTicketDto,
} from './dto';

/**
 * 工单域外观：HTTP 层的承诺保持不变（controller 注入与返回结构不变），
 * 实现按域拆到 tickets/ 下的内聚模块——
 * - 查询：TicketQueries（列表/详情/筛选人员/历史）
 * - 写入：TicketEditor（建单/编辑）
 * - 生命周期：TicketLifecycle（指派/状态流转）
 * - 消息：TicketMessaging（回复/内部备注/编辑正文）
 * - 协作人：TicketParticipants（协作成员/关注人）
 * - 删除：TicketDeletion（含对象存储删除 outbox）
 * 共享 helper 在 tickets/core.ts，可见性唯一定义在 tickets/visibility.ts。
 *
 * 六个域实现注册在 TicketsModule.providers，由构造器注入：每个域可独立
 * mock/override，并享有 provider 生命周期。回归测试通过
 * test/tickets-service.fixture.ts 以原始依赖装配各域。
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly queries: TicketQueries,
    private readonly editor: TicketEditor,
    private readonly lifecycle: TicketLifecycle,
    private readonly messaging: TicketMessaging,
    private readonly participantsDomain: TicketParticipants,
    private readonly deletion: TicketDeletion,
  ) {}

  // ---------- 查询 ----------
  list(user: AuthUser, q: ListTicketsQuery) {
    return this.queries.list(user, q);
  }

  filterPeople(user: AuthUser) {
    return this.queries.filterPeople(user);
  }

  findOne(user: AuthUser, id: string) {
    return this.queries.findOne(user, id);
  }

  async history_(user: AuthUser, id: string) {
    // 统一复用详情的可见性判定，协作成员也可查看审计历史。
    await this.findOne(user, id);
    return this.queries.history(id);
  }

  // ---------- 写入 ----------
  async create(user: AuthUser, dto: CreateTicketDto) {
    const id = await this.editor.create(user, dto);
    return this.findOne(user, id);
  }

  async update(user: AuthUser, id: string, dto: UpdateTicketDto) {
    const updatedId = await this.editor.update(user, id, dto);
    return this.findOne(user, updatedId);
  }

  // ---------- 生命周期 ----------
  async assign(user: AuthUser, id: string, dto: AssignDto) {
    const assignedId = await this.lifecycle.assign(user, id, dto);
    return this.findOne(user, assignedId);
  }

  async transition(user: AuthUser, id: string, action: TicketAction) {
    const transitionedId = await this.lifecycle.transition(user, id, action);
    return this.findOne(user, transitionedId);
  }

  // ---------- 消息 ----------
  addMessage(user: AuthUser, id: string, dto: CreateMessageDto) {
    return this.messaging.addMessage(user, id, dto);
  }

  updateMessage(
    user: AuthUser,
    ticketId: string,
    messageId: string,
    dto: CreateMessageDto,
  ) {
    return this.messaging.updateMessage(user, ticketId, messageId, dto);
  }

  // ---------- 协作成员 / 关注人 ----------
  async participants(user: AuthUser, id: string) {
    const ticket = await this.findOne(user, id);
    return ticket.participants;
  }

  participantCandidates(user: AuthUser, id: string) {
    return this.participantsDomain.participantCandidates(user, id);
  }

  addParticipant(user: AuthUser, id: string, dto: AddParticipantDto) {
    return this.participantsDomain.addParticipant(user, id, dto);
  }

  removeParticipant(user: AuthUser, id: string, userId: string) {
    return this.participantsDomain.removeParticipant(user, id, userId);
  }

  // ---------- 删除 ----------
  remove(user: AuthUser, id: string) {
    return this.deletion.remove(user, id);
  }
}
