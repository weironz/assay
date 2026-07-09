import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './decorators';

/**
 * 全局会话守卫：校验 better-auth 会话，把用户挂到 req.user。
 * @Public() 标记的接口跳过登录要求（但仍会尝试解析用户）。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = await this.authService.getUserFromRequest(req);
    if (user) req.user = user;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!user) throw new UnauthorizedException('未登录');
    if (user.status === 'DISABLED') {
      throw new UnauthorizedException('账号已被禁用');
    }
    return true;
  }
}
