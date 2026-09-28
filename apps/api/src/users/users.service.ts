import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from '../auth/auth';
import { isSystemRoleName } from '../auth/role-policy';
import { privilegedMfaMode } from '../auth/step-up-store';
import { assertCanLoseActiveAdmin } from '../auth/last-admin';
import { CreateUserDto, UpdateUserDto } from './dto';
import { assertSessionEpochMigration } from '../auth/session-epoch';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private serialize(user: any) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      phone: user.phone,
      status: user.status,
      roles:
        user.roles
          ?.map((ur: any) => ur.role.name)
          .filter(isSystemRoleName) ?? [],
      createdAt: user.createdAt,
    };
  }

  async list() {
    const users = await this.prisma.user.findMany({
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return users.map((u) => this.serialize(u));
  }

  async create(dto: CreateUserDto) {
    if (privilegedMfaMode() === 'enforce' && dto.roleNames.some((r) => r === 'admin' || r === 'supervisor')) {
      throw new BadRequestException('强制 MFA 模式下请先创建普通账号、完成 TOTP 绑定，再授予特权角色');
    }
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (exists) throw new BadRequestException('邮箱已存在');

    // 通过 better-auth 创建账号（写入 user + account 密码）
    await auth.api.signUpEmail({
      body: { email: dto.email, password: dto.password, name: dto.name },
    });
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) throw new BadRequestException('创建失败');

    // Better Auth owns signup and its credential records. Keep all of our
    // post-signup profile and role writes atomic, although signup itself
    // cannot join this transaction.
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          username: dto.username,
          phone: dto.phone,
          emailVerified: true,
        },
      });
      await this.setRoles(tx, user.id, dto.roleNames);
    });
    return this.findOne(user.id);
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return this.serialize(user);
  }

  async update(id: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    if (privilegedMfaMode() === 'enforce' && dto.roleNames?.some((r) => r === 'admin' || r === 'supervisor') && !user.twoFactorEnabled) {
      throw new BadRequestException('目标用户需先完成 TOTP 绑定才能获得特权角色');
    }
    if (dto.status === 'DISABLED' || (dto.roleNames && !dto.roleNames.includes('admin'))) {
      await assertCanLoseActiveAdmin(this.prisma, id);
    }
    const authContext = dto.status === 'DISABLED' ? await auth.$context : null;
    if (authContext) await authContext.internalAdapter.deleteUserSessions(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          name: dto.name, phone: dto.phone, status: dto.status,
          ...(dto.status === 'DISABLED' ? { sessionEpoch: { increment: 1 } } : {}),
        },
      });
      if (dto.roleNames) await this.setRoles(tx, id, dto.roleNames);
    });
    if (authContext) await authContext.internalAdapter.deleteUserSessions(id);
    return this.findOne(id);
  }

  async remove(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    await assertCanLoseActiveAdmin(this.prisma, id);
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUserSessions(id);
    await this.prisma.user.delete({ where: { id } });
    await ctx.internalAdapter.deleteUserSessions(id);
    return { ok: true };
  }

  /** 管理员重置某用户密码（用户忘记密码的兜底，无需原密码） */
  async resetPassword(id: string, newPassword: string) {
    await assertSessionEpochMigration(this.prisma);
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    // 用 better-auth 内部哈希器，保证与登录校验一致
    const ctx = await auth.$context;
    const hashed = await ctx.password.hash(newPassword);
    // Better Auth keeps active sessions in Redis when secondaryStorage is
    // configured. Its own adapter removes token keys and the per-user index.
    await ctx.internalAdapter.deleteUserSessions(id);
    await this.prisma.$transaction(async (tx) => {
      const acc = await tx.account.findFirst({
        where: { userId: id, providerId: 'credential' },
      });
      if (acc) {
        await tx.account.update({
          where: { id: acc.id },
          data: { password: hashed },
        });
      } else {
        await tx.account.create({
          data: {
            userId: id,
            accountId: id,
            providerId: 'credential',
            password: hashed,
          },
        });
      }
    });
    // Catch sessions created during the credential update. Better Auth's
    // Redis session index is not atomic with concurrent session creation.
    await ctx.internalAdapter.deleteUserSessions(id);
    return { ok: true };
  }

  /** 重置用户的角色集合 */
  private async setRoles(db: Pick<Prisma.TransactionClient, 'role' | 'userRole'>, userId: string, roleNames: string[]) {
    const names = [...new Set(roleNames)];
    if (!names.every(isSystemRoleName)) {
      throw new BadRequestException('包含非系统角色');
    }
    const roles = await db.role.findMany({
      where: { name: { in: names } },
    });
    if (roles.length !== names.length) {
      throw new BadRequestException('系统角色尚未初始化');
    }
    const current = await db.userRole.findMany({ where: { userId }, select: { roleId: true } });
    const wanted = new Set(roles.map((r) => r.id));
    const existing = new Set(current.map((r) => r.roleId));
    const additions = roles.filter((r) => !existing.has(r.id));
    if (additions.length) await db.userRole.createMany({
      data: additions.map((r) => ({ userId, roleId: r.id })), skipDuplicates: true,
    });
    const removals = current.filter((r) => !wanted.has(r.roleId)).map((r) => r.roleId);
    if (removals.length) await db.userRole.deleteMany({ where: { userId, roleId: { in: removals } } });
  }
}
