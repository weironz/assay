import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsHexColor, IsOptional, IsString, MinLength } from 'class-validator';
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
