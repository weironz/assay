import { Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from './auth';
import { AuthUser } from './auth.types';

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

    const roles = user.roles.map((ur) => ur.role.name);
    const permissions = Array.from(
      new Set(
        user.roles.flatMap((ur) =>
          ur.role.permissions.map((rp) => rp.permission.code),
        ),
      ),
    );

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      status: user.status,
      roles,
      permissions,
    };
  }
}
