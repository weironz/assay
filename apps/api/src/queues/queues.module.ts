import { Module } from '@nestjs/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../auth/decorators';

class QueueDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  defaultAssigneeId?: string;
}

@Controller('queues')
class QueuesController {
  constructor(private readonly prisma: PrismaService) {}

  // 查看队列：登录即可（工单指派需要）
  @Get()
  list() {
    return this.prisma.queue.findMany({ orderBy: { name: 'asc' } });
  }

  @Post()
  @RequirePermissions('queue:manage')
  create(@Body() dto: QueueDto) {
    return this.prisma.queue.create({ data: dto });
  }

  @Patch(':id')
  @RequirePermissions('queue:manage')
  update(@Param('id') id: string, @Body() dto: QueueDto) {
    return this.prisma.queue.update({ where: { id }, data: dto });
  }

  @Delete(':id')
  @RequirePermissions('queue:manage')
  remove(@Param('id') id: string) {
    return this.prisma.queue.delete({ where: { id } });
  }
}

@Module({
  controllers: [QueuesController],
})
export class QueuesModule {}
