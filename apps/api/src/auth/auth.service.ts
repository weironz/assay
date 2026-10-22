import { Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from './auth';
import { AuthUser } from './auth.types';
import { isSystemRoleName } from './role-policy';
import { directorySettings, refreshDirectoryIdentity, validatedDirectorySession } from './directory-runtime';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { assertSessionEpoch } from './session-epoch';
import { webSessionFingerprint, webSessionScopes } from './web-session-scope';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apiTokens: ApiTokensService,
  ) {}

  /** 校验请求会话，返回带角色/权限的用户；未登录返回 null */
  async getUserFromRequest(req: Request): Promise<AuthUser | null> {
    const authorization = req.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const record = await this.apiTokens.findActiveBySecret(authorization.slice(7).trim());
      if (!record) return null;
      const identity = directorySettings && await this.prisma.directoryIdentity.findUnique({ where: { userId: record.user.id } });
      let directoryRoles: string[] = [];
      if (identity) {
        try { directoryRoles = (await refreshDirectoryIdentity(this.prisma, record.user.id)).roleNames; }
        catch { return null; }
      }
      return this.toAuthUser(record.user, { id: record.id, scopes: record.scopes },
        await this.directoryRolesFromDb(directoryRoles));
    }

    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session?.user) return null;
    await assertSessionEpoch(this.prisma, session.session.token, session.user.id);

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
    let directoryRoles: string[] = [];
    let directorySession = false;
    try {
      const state = await validatedDirectorySession(this.prisma, session.session.token, user.id);
      directorySession = !!state; directoryRoles = state?.roleNames || [];
    }
    catch { return null; }
    if (process.env.FILES_ENABLED === 'true')
      webSessionScopes.set(req, { fingerprint: webSessionFingerprint(session.session.token), expiresAt: new Date(session.session.expiresAt).getTime() });
    return { ...this.toAuthUser(user, null, await this.directoryRolesFromDb(directoryRoles)),
      passwordSource: directorySession ? 'directory' : 'local' };
  }

  /**
   * 角色→权限的真源统一在数据库（seed 按代码基线写入，RolesController 读库）：
   * 目录账号与本地账号走同一张 RolePermission 表，不再由目录路径绕过数据库
   * 直接引用 SYSTEM_ROLE_PERMISSIONS 常量——常量只是 seed 的输入。
   */
  private async directoryRolesFromDb(roleNames: string[]): Promise<
    { name: string; permissions: { permission: { code: string } }[] }[]
  > {
    const names = roleNames.filter(isSystemRoleName);
    if (!names.length) return [];
    return this.prisma.role.findMany({
      where: { name: { in: names } },
      select: { name: true, permissions: { select: { permission: { select: { code: true } } } } },
    });
  }

  private toAuthUser(
    user: {
      id: string; email: string; name: string; username: string | null; image: string | null;
      emailVerified: boolean; twoFactorEnabled: boolean; status: string; defaultContact: unknown;
      roles: { role: { name: string; permissions: { permission: { code: string } }[] } }[];
    },
    token: { id: string; scopes: string[] } | null,
    directoryRoles: { name: string; permissions: { permission: { code: string } }[] }[] = [],
  ): AuthUser {

    // 只承认代码定义的岗位角色，遗留或手工插入的角色不应扩大权限。
    const systemRoles = user.roles.filter((ur) => isSystemRoleName(ur.role.name));
    const roles = [...new Set([...systemRoles.map((ur) => ur.role.name), ...directoryRoles.map((r) => r.name)])];
    const rolePermissions = Array.from(
      new Set(
        systemRoles.flatMap((ur) =>
          ur.role.permissions.map((rp) => rp.permission.code),
        ).concat(directoryRoles.flatMap((r) => r.permissions.map((rp) => rp.permission.code))),
      ),
    );

    const permissions = token
      ? rolePermissions.filter((permission) => token.scopes.includes(permission))
      : rolePermissions;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      image: user.image,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      status: user.status,
      defaultContact: (user.defaultContact as AuthUser['defaultContact']) ?? null,
      authType: token ? 'token' : 'session',
      tokenId: token?.id,
      tokenScopes: token?.scopes,
      roles,
      permissions,
    };
  }
}
