import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  /** 角色列表（含权限码），供用户管理页选择角色 */
  @Get('roles')
  roles() {
    return this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }

  @Get('permissions')
  permissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }
}
