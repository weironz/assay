import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth.types';
import { PERMISSIONS_KEY } from './decorators';

/**
 * 权限守卫（RBAC）：读取 @RequirePermissions 元数据，
 * 校验 req.user.permissions 是否包含全部所需权限码。
 * 在 SessionGuard 之后执行（用户已挂载）。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    if (!user) throw new ForbiddenException('无权限');

    const ok = required.every((p) => user.permissions.includes(p));
    if (!ok) {
      throw new ForbiddenException(`缺少权限: ${required.join(', ')}`);
    }
    return true;
  }
}
