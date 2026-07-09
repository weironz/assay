import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { QueuesModule } from './queues/queues.module';
import { TicketsModule } from './tickets/tickets.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SlaModule } from './sla/sla.module';
import { StatsModule } from './stats/stats.module';
import { SavedViewsModule } from './saved-views/saved-views.module';
import { HealthController } from './health/health.controller';
import { SessionGuard } from './auth/session.guard';
import { PermissionsGuard } from './auth/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'redis',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
    }),
    PrismaModule,
    StorageModule,
    AuthModule,
    UsersModule,
    QueuesModule,
    TicketsModule,
    AttachmentsModule,
    NotificationsModule,
    SlaModule,
    StatsModule,
    SavedViewsModule,
  ],
  controllers: [HealthController],
  providers: [
    // 顺序重要：先会话守卫（挂载用户），再权限守卫
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
