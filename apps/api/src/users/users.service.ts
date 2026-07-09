import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from '../auth/auth';
import { CreateUserDto, UpdateUserDto } from './dto';

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
      roles: user.roles?.map((ur: any) => ur.role.name) ?? [],
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

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        username: dto.username,
        phone: dto.phone,
        emailVerified: true,
      },
    });
    await this.setRoles(user.id, dto.roleNames);
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

    await this.prisma.user.update({
      where: { id },
      data: { name: dto.name, phone: dto.phone, status: dto.status },
    });
    if (dto.roleNames) await this.setRoles(id, dto.roleNames);
    return this.findOne(id);
  }

  async remove(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }

  /** 重置用户的角色集合 */
  private async setRoles(userId: string, roleNames: string[]) {
    const roles = await this.prisma.role.findMany({
      where: { name: { in: roleNames } },
    });
    if (roles.length !== roleNames.length) {
      throw new BadRequestException('包含未知角色');
    }
    await this.prisma.userRole.deleteMany({ where: { userId } });
    await this.prisma.userRole.createMany({
      data: roles.map((r) => ({ userId, roleId: r.id })),
      skipDuplicates: true,
    });
  }
}
