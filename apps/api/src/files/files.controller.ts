import { Body, Controller, Delete, Get, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { enabledModules } from './contracts';
import { FilesService } from './files.service';
@Controller('modules')
export class ModulesController { @Get() flags() { return enabledModules(); } }
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}
  @Get('status') status(@Req() req: Request, @CurrentUser() user: AuthUser) { return this.files.status(req, user); }
  @Post('session') login(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) { return this.files.login(req, user, body); }
  @Delete('session') logout(@Req() req: Request, @CurrentUser() user: AuthUser) { return this.files.logout(req, user); }
  @Get('list') list(@Req() req: Request, @CurrentUser() user: AuthUser, @Query() query: unknown) { return this.files.list(req, user, query); }
  @Post('commands') command(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: unknown) { return this.files.command(req, user, body); }
  @Get('content') download(@Req() req: Request, @Res() res: Response, @CurrentUser() user: AuthUser, @Query() query: unknown) { return this.files.transfer(req, res, user, query, false); }
  @Put('content') upload(@Req() req: Request, @Res() res: Response, @CurrentUser() user: AuthUser, @Query() query: unknown) { return this.files.transfer(req, res, user, query, true); }
}
