import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { TicketAction } from './workflow.service';
import {
  AssignDto,
  CreateMessageDto,
  CreateTicketDto,
  ListTicketsQuery,
  TransitionDto,
  UpdateTicketDto,
} from './dto';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequirePermissions('ticket:read')
  list(@CurrentUser() user: AuthUser, @Query() q: ListTicketsQuery) {
    return this.tickets.list(user, q);
  }

  @Post()
  @RequirePermissions('ticket:create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.tickets.create(user, dto);
  }

  @Get(':id')
  @RequirePermissions('ticket:read')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tickets.findOne(user, id);
  }

  @Patch(':id')
  @RequirePermissions('ticket:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.tickets.update(user, id, dto);
  }

  @Post(':id/assign')
  @RequirePermissions('ticket:assign')
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssignDto,
  ) {
    return this.tickets.assign(user, id, dto);
  }

  @Post(':id/transition')
  @RequirePermissions('ticket:transition')
  transition(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: TransitionDto,
  ) {
    return this.tickets.transition(user, id, dto.action as TicketAction);
  }

  @Get(':id/history')
  @RequirePermissions('ticket:read')
  history(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tickets.history_(user, id);
  }

  @Delete(':id')
  @RequirePermissions('ticket:read')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tickets.remove(user, id); // 服务内再校验 admin
  }

  @Get(':id/messages')
  @RequirePermissions('ticket:read')
  messages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tickets.findOne(user, id).then((t) => t.messages);
  }

  @Post(':id/messages')
  @RequirePermissions('ticket:comment')
  addMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.tickets.addMessage(user, id, dto);
  }

  @Patch(':id/messages/:messageId')
  @RequirePermissions('ticket:comment')
  updateMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.tickets.updateMessage(user, id, messageId, dto);
  }
}
