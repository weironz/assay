import { Body, Controller, Get, Param, Patch, Post, Delete, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';
import { directoryRoleUserIds } from '../auth/directory-policy';

class CategoryDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

export class PresetNameDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/)
  name!: string;
}

class TagDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsHexColor()
  color?: string;
}

/** 一年，够离谱的配置值也拦得住，同时不至于挡住「30 天」这种合理长时限 */
const MAX_SLA_MIN = 525_600;

class TicketTypeDto {
  @IsString()
  @MinLength(1)
  name!: string;

  /** 首次响应时限（分钟） */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MIN)
  slaResponseMin!: number;

  /** 解决时限（分钟） */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MIN)
  slaResolveMin!: number;
}

class UpdateTicketTypeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MIN)
  slaResponseMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MIN)
  slaResolveMin?: number;
}

/** 工单分类 / 标签 / 类型（列表登录可见，写入需管理权限） */
@Controller()
export class MetaController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('categories')
  categories() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }

  @Post('categories')
  @RequirePermissions('user:manage')
  createCategory(@Body() dto: CategoryDto) {
    return this.prisma.category.create({ data: dto });
  }

  @Get('tags')
  tags() {
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' } });
  }

  @Post('tags')
  @RequirePermissions('ticket:update')
  createTag(@Body() dto: TagDto) {
    return this.prisma.tag.create({
      data: { name: dto.name, color: dto.color ?? '#888888' },
    });
  }

  @Get('ticket-types')
  types() {
    return this.prisma.ticketType.findMany({ orderBy: { name: 'asc' } });
  }

  @Post('ticket-types')
  @RequirePermissions('queue:manage')
  createType(@Body() dto: TicketTypeDto) {
    return this.prisma.ticketType.create({ data: dto });
  }

  /**
   * 改 SLA 只影响之后新建的工单：在跑的工单截止时刻建单时就算好了，
   * 回头改配置去动它们会让「还剩多久」凭空跳变，处理人无所适从。
   */
  @Patch('ticket-types/:id')
  @RequirePermissions('queue:manage')
  updateType(@Param('id') id: string, @Body() dto: UpdateTicketTypeDto) {
    return this.prisma.ticketType.update({ where: { id }, data: dto });
  }

  @Get('datacenters')
  datacenters() {
    return this.prisma.datacenter.findMany({ orderBy: { name: 'asc' } });
  }

  private assertAdmin(user: AuthUser) {
    if (!user.roles.includes('admin')) throw new ForbiddenException('仅管理员可维护工单字段');
  }

  private async presetWrite(operation: () => Promise<unknown>) {
    try { return await operation(); }
    catch (error: any) {
      if (error.code === 'P2002') throw new ConflictException('名称已存在');
      if (error.code === 'P2003') throw new ConflictException('选项已被业务记录引用，不能删除');
      if (error.code === 'P2025') throw new NotFoundException('选项不存在');
      throw error;
    }
  }

  @Post('datacenters')
  @RequirePermissions('user:manage')
  createDatacenter(@CurrentUser() user: AuthUser, @Body() dto: PresetNameDto) {
    this.assertAdmin(user);
    return this.presetWrite(() => this.prisma.datacenter.create({ data: { name: dto.name.trim() } }));
  }

  @Patch('datacenters/:id')
  @RequirePermissions('user:manage')
  updateDatacenter(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PresetNameDto) {
    this.assertAdmin(user);
    return this.presetWrite(() => this.prisma.datacenter.update({ where: { id }, data: { name: dto.name.trim() } }));
  }

  @Delete('datacenters/:id')
  @RequirePermissions('user:manage')
  removeDatacenter(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    this.assertAdmin(user);
    return this.presetWrite(async () => {
      // Prevent set-null relations from silently stripping old tickets/assets.
      return this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM datacenters WHERE id = ${id} FOR UPDATE`;
        const used = await tx.datacenter.findUnique({ where: { id }, include: { _count: { select: { tickets: true, assets: true, clusters: true } } } });
        if (!used) throw new NotFoundException('选项不存在');
        if (Object.values(used._count).some(count => count > 0)) throw new ConflictException('选项已被业务记录引用，不能删除');
        return tx.datacenter.delete({ where: { id } });
      });
    });
  }

  /** 带 datacenterId 供前端按所选机房过滤集群 */
  @Get('clusters')
  clusters() {
    return this.prisma.cluster.findMany({ orderBy: { name: 'asc' } });
  }

  /** 可指派的处理人（handler/admin 角色），供指派下拉使用（登录可见） */
  @Get('assignees')
  async assignees() {
    const directoryHandlers = await directoryRoleUserIds(this.prisma, ['handler', 'admin']);
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { roles: { some: { role: { name: { in: ['handler', 'admin'] } } } }, ...(process.env.DIRECTORY_AUTH_ENABLED === 'true' ? { directoryIdentity: null } : {}) },
          { id: { in: directoryHandlers } },
        ],
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return users;
  }
}
