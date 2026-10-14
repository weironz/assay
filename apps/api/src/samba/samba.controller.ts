import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { SambaService } from './samba.service';

@Controller('samba')
export class SambaController {
  constructor(private readonly samba: SambaService, private readonly stepUp: StepUpService) {}
  @Get('snapshot') @RequirePermissions('samba:read') snapshot() { return this.samba.snapshot(); }
  @Get('directories') @RequirePermissions('samba:read') directories(@Query() q: unknown) { return this.samba.directories(q); }
  @Get('acl') @RequirePermissions('samba:read') acl(@Query() q: unknown) { return this.samba.directories(q, true); }
  @Get('operations') @RequirePermissions('samba:read') history() { return this.samba.history(); }
  @Get('operations/:id') @RequirePermissions('samba:read') operation(@Param('id') id: string) { return this.samba.operation(id); }
  @Post('commands') @RequirePermissions('samba:manage') async command(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.stepUp.consume(req, user, 'samba'); return this.samba.command(user, body);
  }
  @Post('bindings') @RequirePermissions('samba:manage') async bind(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.stepUp.consume(req, user, 'samba'); return this.samba.bind(user, body);
  }
  @Get('me/operations/:id') ownOperation(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.samba.ownOperation(user, id); }
  @Get('me') identity(@CurrentUser() user: AuthUser) { return this.samba.identity(user); }
  @Post('me/password') async password(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.stepUp.consume(req, user, 'account'); return this.samba.selfPassword(user, body);
  }
}
