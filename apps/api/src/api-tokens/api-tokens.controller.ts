import { Body, Controller, Delete, Get, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { CreateApiTokenDto } from './api-tokens.dto';
import { ApiTokensService } from './api-tokens.service';
import { StepUpService } from '../auth/step-up.service';

@Controller('me/api-tokens')
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService, private readonly stepUp: StepUpService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) { this.requireSession(user); return this.tokens.list(user); }

  @Post()
  async create(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() dto: CreateApiTokenDto) {
    await this.stepUp.consume(req, user, 'api-tokens');
    return this.tokens.create(user, dto);
  }

  @Post(':id/rotate')
  async rotate(@Req() req: Request, @CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.stepUp.consume(req, user, 'api-tokens');
    return this.tokens.rotate(user, id);
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) { this.requireSession(user); return this.tokens.revoke(user, id); }

  private requireSession(user: AuthUser) {
    if (user.authType === 'token') throw new UnauthorizedException('API Token 不可管理 API Token');
  }
}
