import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../auth/decorators';

class CategoryDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  parentId?: string;
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

  /** 带 datacenterId 供前端按所选机房过滤集群 */
  @Get('clusters')
  clusters() {
    return this.prisma.cluster.findMany({ orderBy: { name: 'asc' } });
  }

  /** 可指派的处理人（handler/admin 角色），供指派下拉使用（登录可见） */
  @Get('assignees')
  async assignees() {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        roles: { some: { role: { name: { in: ['handler', 'admin'] } } } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return users;
  }
}
