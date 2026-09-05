import { Body, Controller, Delete, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { CreateApiTokenDto } from './api-tokens.dto';
import { ApiTokensService } from './api-tokens.service';

@Controller('me/api-tokens')
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) { this.requireSession(user); return this.tokens.list(user); }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApiTokenDto) { this.requireSession(user); return this.tokens.create(user, dto); }

  @Post(':id/rotate')
  rotate(@CurrentUser() user: AuthUser, @Param('id') id: string) { this.requireSession(user); return this.tokens.rotate(user, id); }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) { this.requireSession(user); return this.tokens.revoke(user, id); }

  private requireSession(user: AuthUser) {
    if (user.authType === 'token') throw new UnauthorizedException('API Token 不可管理 API Token');
  }
}
