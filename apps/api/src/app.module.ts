import { SambaModule } from './samba/samba.module';
import { FilesModule } from './files/files.module';
import { OperationsModule } from './operations/operations.module';
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
import { MailModule } from './mail/mail.module';
import { ProfileModule } from './profile/profile.module';
import { SlaModule } from './sla/sla.module';
import { StatsModule } from './stats/stats.module';
import { SavedViewsModule } from './saved-views/saved-views.module';
import { ApiTokensModule } from './api-tokens/api-tokens.module';
import { TicketSharesModule } from './ticket-shares/ticket-shares.module';
import { HealthController } from './health/health.controller';
import { SessionGuard } from './auth/session.guard';
import { PermissionsGuard } from './auth/permissions.guard';

@Module({
  imports: [
    OperationsModule,
    SambaModule,
    FilesModule,
    ConfigModule.forRoot({ isGlobal: true }),
    // REDIS_URL 优先（可携带密码/TLS）；未设置时退回 HOST/PORT 组合。
    // 与 ioredis 约定一致：url 存在时 host/port 被忽略。
    BullModule.forRoot(
      process.env.REDIS_URL
        ? { connection: { url: process.env.REDIS_URL } }
        : {
            connection: {
              host: process.env.REDIS_HOST || 'redis',
              port: Number(process.env.REDIS_PORT) || 6379,
            },
          },
    ),
    PrismaModule,
    StorageModule,
    AuthModule,
    ApiTokensModule,
    TicketSharesModule,
    UsersModule,
    QueuesModule,
    TicketsModule,
    AttachmentsModule,
    MailModule,
    ProfileModule,
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
