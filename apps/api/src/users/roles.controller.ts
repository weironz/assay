import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../auth/decorators';
import { SYSTEM_ROLE_NAMES } from '../auth/role-policy';

@Controller()
export class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  /** 固定岗位角色列表，供用户管理页分配角色。 */
  @Get('roles')
  @RequirePermissions('user:manage')
  async roles() {
    const roles = await this.prisma.role.findMany({
      where: { name: { in: [...SYSTEM_ROLE_NAMES] } },
      select: { id: true, name: true, description: true },
    });
    const byName = new Map(roles.map((role) => [role.name, role]));
    return SYSTEM_ROLE_NAMES.flatMap((name) => {
      const role = byName.get(name);
      return role ? [role] : [];
    });
  }
}
