import { Module } from '@nestjs/common';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../auth/decorators';
import { AuthUser } from '../auth/auth.types';

class SavedViewDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsObject()
  filter!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isShared?: boolean;
}

@Controller('saved-views')
class SavedViewsController {
  constructor(private readonly prisma: PrismaService) {}

  /** 自己的视图 + 共享视图 */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.savedView.findMany({
      where: { OR: [{ userId: user.id }, { isShared: true }] },
      orderBy: { name: 'asc' },
    });
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: SavedViewDto) {
    return this.prisma.savedView.create({
      data: {
        userId: user.id,
        name: dto.name,
        filterJson: dto.filter as any,
        isShared: dto.isShared ?? false,
      },
    });
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const v = await this.prisma.savedView.findUnique({ where: { id } });
    if (!v) return { ok: true };
    if (v.userId !== user.id && !user.roles.includes('admin')) {
      throw new ForbiddenException('无权删除他人视图');
    }
    await this.prisma.savedView.delete({ where: { id } });
    return { ok: true };
  }
}

@Module({
  controllers: [SavedViewsController],
})
export class SavedViewsModule {}
