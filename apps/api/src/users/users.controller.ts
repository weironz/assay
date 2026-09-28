import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from './users.service';
import { CreateUserDto, ResetPasswordDto, UpdateUserDto } from './dto';
import { RequirePermissions } from '../auth/decorators';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';

@Controller('users')
@RequirePermissions('user:manage')
export class UsersController {
  constructor(private readonly users: UsersService, private readonly stepUp: StepUpService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOne(id);
  }

  @Post()
  async create(@Req() req: Request, @CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto) {
    await this.stepUp.consume(req, actor, 'roles');
    return this.users.create(dto);
  }

  @Patch(':id')
  async update(@Req() req: Request, @CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    if (dto.roleNames !== undefined || dto.status !== undefined) await this.stepUp.consume(req, actor, 'roles');
    return this.users.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @CurrentUser() actor: AuthUser, @Param('id') id: string) {
    await this.stepUp.consume(req, actor, 'roles');
    return this.users.remove(id);
  }

  @Post(':id/reset-password')
  async resetPassword(@Req() req: Request, @CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    await this.stepUp.consume(req, actor, 'roles');
    return this.users.resetPassword(id, dto.newPassword);
  }
}
