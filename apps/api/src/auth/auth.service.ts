import { Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from './auth';
import { AuthUser } from './auth.types';
import { isSystemRoleName } from './role-policy';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /** 校验请求会话，返回带角色/权限的用户；未登录返回 null */
  async getUserFromRequest(req: Request): Promise<AuthUser | null> {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session?.user) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
      include: {
        roles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });
    if (!user) return null;

    // 只承认代码定义的岗位角色，遗留或手工插入的角色不应扩大权限。
    const systemRoles = user.roles.filter((ur) => isSystemRoleName(ur.role.name));
    const roles = systemRoles.map((ur) => ur.role.name);
    const permissions = Array.from(
      new Set(
        systemRoles.flatMap((ur) =>
          ur.role.permissions.map((rp) => rp.permission.code),
        ),
      ),
    );

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      image: user.image,
      emailVerified: user.emailVerified,
      status: user.status,
      defaultContact: (user.defaultContact as AuthUser['defaultContact']) ?? null,
      roles,
      permissions,
    };
  }
}
