import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from './decorators';
import { AuthUser } from './auth.types';

@Controller('auth')
export class AuthController {
  /** 当前登录用户（含角色与权限），前端启动时拉取 */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
