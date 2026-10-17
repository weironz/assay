import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { releaseSuccessfulStepUpAttempt } from '../auth/step-up-store';
import { selfPasswordSchema } from './contracts';
import { SambaService } from './samba.service';

@Controller('samba')
export class SambaController {
  constructor(private readonly samba: SambaService, private readonly stepUp: StepUpService) {}
  @Get('snapshot') @RequirePermissions('samba:read') snapshot() { return this.samba.snapshot(); }
  @Post('rename-preview') @HttpCode(200) @RequirePermissions('samba:manage') preview(@Body() body:unknown) { return this.samba.renamePreview(body); }
  @Get('directories') @RequirePermissions('samba:read') directories(@Query() q: unknown) { return this.samba.directories(q); }
  @Get('acl') @RequirePermissions('samba:read') acl(@Query() q: unknown) { return this.samba.directories(q, true); }
  @Get('operations') @RequirePermissions('samba:read') history() { return this.samba.history(); }
  @Get('audit') @RequirePermissions('samba:read') audit() { return this.samba.audit(); }
  @Get('dns') @RequirePermissions('samba:read') dns(@Query('zone') zone?: string) { return this.samba.dns(zone); }
  @Get('sessions') @RequirePermissions('samba:read') sessions() { return this.samba.sessions(); }
  @Get('operations/:id') @RequirePermissions('samba:read') operation(@Param('id') id: string) { return this.samba.operation(id); }
  @Post('commands') @RequirePermissions('samba:manage') async command(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.stepUp.consume(req, user, 'samba'); return this.samba.command(user, body);
  }
  @Post('users/bulk') @RequirePermissions('samba:manage') async bulk(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.stepUp.consume(req, user, 'samba'); return this.samba.bulkCreate(user, body);
  }
  @Post('bindings') @RequirePermissions('samba:manage') async bind(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    await this.stepUp.consume(req, user, 'samba'); return this.samba.bind(user, body);
  }
  @Get('me/operations/:id') ownOperation(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.samba.ownOperation(user, id); }
  @Get('me') identity(@CurrentUser() user: AuthUser) { return this.samba.identity(user); }
  @Post('me/password') async password(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    const parsed = selfPasswordSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('密码参数无效');
    // Retain compatibility with clients that already obtained a one-use proof.
    const legacy = !!req.headers['x-step-up-token'];
    if (legacy) await this.stepUp.consume(req, user, 'account');
    else await this.stepUp.preparePasswordChange(req, user, parsed.data.code);
    const operation = await this.samba.selfPassword(user, parsed.data);
    // Counter cleanup must not turn a confirmed AD password change into an error.
    if (!legacy && operation.state === 'succeeded') await releaseSuccessfulStepUpAttempt(user.id).catch(() => {});
    return operation;
  }
}
