import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from './auth';

/**
 * 启动时确保存在一个管理员账号。
 * 通过 better-auth 注册（密码正确哈希，能真正登录），再挂上 admin 角色。
 */
@Injectable()
export class AuthBootstrapService implements OnModuleInit {
  private readonly logger = new Logger('AuthBootstrap');

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || 'admin12345';
    const name = process.env.ADMIN_NAME || '系统管理员';

    const adminRole = await this.prisma.role.findUnique({
      where: { name: 'admin' },
    });
    if (!adminRole) {
      this.logger.warn('未找到 admin 角色（seed 未执行？），跳过管理员自举');
      return;
    }

    let user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      try {
        await auth.api.signUpEmail({ body: { email, password, name } });
        user = await this.prisma.user.findUnique({ where: { email } });
        this.logger.log(`已创建管理员账号: ${email}`);
      } catch (e) {
        this.logger.error(`创建管理员失败: ${(e as Error).message}`);
        return;
      }
    }
    if (!user) return;

    // 补充业务字段 + 挂 admin 角色
    await this.prisma.user.update({
      where: { id: user.id },
      data: { username: user.username ?? 'admin', emailVerified: true },
    });
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      update: {},
      create: { userId: user.id, roleId: adminRole.id },
    });
    this.logger.log(`管理员就绪: ${email} / 默认密码见 .env(ADMIN_PASSWORD)`);
  }
}
