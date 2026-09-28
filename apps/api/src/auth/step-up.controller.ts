import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import type { Request } from 'express';
import { CurrentUser } from './decorators';
import type { AuthUser } from './auth.types';
import { StepUpService } from './step-up.service';
import type { StepUpPurpose } from './step-up-store';

class StepUpDto {
  @IsIn(['roles', 'api-tokens', 'two-factor', 'account'])
  purpose!: StepUpPurpose;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsString()
  code?: string;
}

@Controller('me/security')
export class StepUpController {
  constructor(private readonly stepUp: StepUpService) {}

  @Get()
  status(@Req() req: Request, @CurrentUser() user: AuthUser) {
    return this.stepUp.status(req, user);
  }

  @Post('step-up')
  issue(@Req() req: Request, @CurrentUser() user: AuthUser, @Body() body: StepUpDto) {
    return this.stepUp.issue(req, user, body);
  }
}
