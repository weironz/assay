import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from './auth';
import { assertSessionEpochMigration } from './session-epoch';

/** 仓库 .env.example / 部署模板中公开出现过的默认与占位口令（公开即高危，任何环境禁用） */
const KNOWN_PLACEHOLDER_PASSWORDS = new Set([
  'admin12345',
  'CHANGE_ME_admin_password',
  'please_set_a_strong_password',
]);

/** 启动时对存量管理员账号比对的已知公开默认口令（命中则告警要求轮换） */
const KNOWN_DEFAULT_PASSWORDS = ['admin12345', 'CHANGE_ME_admin_password'];

/**
 * 启动时确保存在一个管理员账号。
 * 通过 better-auth 注册（密码正确哈希，能真正登录），再挂上 admin 角色。
 */
@Injectable()
export class AuthBootstrapService implements OnModuleInit {
  private readonly logger = new Logger('AuthBootstrap');

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Docker dev runs db push before Nest. In development this verifies the
    // epoch column and installs any missing trigger functions/triggers from
    // the checked-in SQL, without marking Prisma migrations as applied.
    // Production must use prisma migrate deploy.
    await assertSessionEpochMigration(this.prisma);
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const name = process.env.ADMIN_NAME || '系统管理员';

    if (!process.env.ADMIN_EMAIL && process.env.NODE_ENV === 'production') {
      this.logger.warn(`未设置 ADMIN_EMAIL，生产环境将使用默认管理员邮箱 ${email}，建议显式配置`);
    }

    const adminRole = await this.prisma.role.findUnique({
      where: { name: 'admin' },
    });
    if (!adminRole) {
      this.logger.warn('未找到 admin 角色（seed 未执行？），跳过管理员自举');
      return;
    }

    let user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      const password = this.bootstrapPassword(email);
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
    // 只保留 admin 角色（注册钩子会给新用户默认加 requester）
    await this.prisma.userRole.deleteMany({
      where: { userId: user.id, roleId: { not: adminRole.id } },
    });
    await this.prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      update: {},
      create: { userId: user.id, roleId: adminRole.id },
    });
    await this.warnIfAdminUsesDefaultPassword(email);
    this.logger.log(`管理员就绪: ${email}`);
  }

  /**
   * 首次创建管理员时的口令策略：
   * - 显式设置了 ADMIN_PASSWORD 时先做强度校验（生产环境拒绝已知默认/占位值），通过才使用；
   * - 生产环境缺失则抛错拒绝启动，杜绝公开默认口令上线；
   * - 其他环境生成一次性随机密码并打印到日志，供本地开发登录后立即修改。
   */
  private bootstrapPassword(email: string): string {
    const explicit = process.env.ADMIN_PASSWORD;
    if (explicit) {
      this.assertBootstrapPasswordStrong(explicit);
      return explicit;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '首次创建管理员必须显式设置 ADMIN_PASSWORD；生产环境不提供默认密码',
      );
    }
    const generated = randomBytes(18).toString('base64url');
    this.logger.warn(
      `未设置 ADMIN_PASSWORD，已为 ${email} 生成一次性随机密码：${generated}（请登录后立即修改）`,
    );
    return generated;
  }

  /**
   * 校验显式配置的管理员口令：
   * - 任何环境都拒绝私库 .env.example / 部署模板里公开的默认与占位值（admin12345、
   *   CHANGE_ME_admin_password、please_set_a_strong_password 等）——它们随时可从
   *   公开仓库拿到，放行等于裸奔，故直接抛错而不是只告警；
   * - 生产环境进一步要求最少 12 位长度；非生产只告警，不阻断本地开发。
   */
  private assertBootstrapPasswordStrong(password: string) {
    if (KNOWN_PLACEHOLDER_PASSWORDS.has(password) || /^change[ _-]?me/i.test(password)) {
      throw new Error(
        'ADMIN_PASSWORD 与仓库公开的默认/占位值相同，任何环境都禁止使用，请更换为高强度密码',
      );
    }
    if (password.length < 12) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('生产环境 ADMIN_PASSWORD 长度不足：至少 12 个字符');
      }
      this.logger.warn('ADMIN_PASSWORD 长度不足 12 位，请勿在正式环境使用该口令');
    }
  }

  /**
   * 已有管理员账号的兜底检查：拿到凭据哈希后与已知公开默认口令逐一比对验证。
   * 命中说明该账号仍是默认密码（典型场景：早期版本写入后从未轮换），在日志持续
   * 告警要求立即轮换。验证仅限生产环境，避免开发机每次启动白跑哈希。
   */
  private async warnIfAdminUsesDefaultPassword(email: string) {
    if (process.env.NODE_ENV !== 'production') return;
    const account = await this.prisma.account.findFirst({
      where: { user: { email }, providerId: 'credential', password: { not: null } },
    });
    if (!account?.password) return;
    const ctx = await auth.$context;
    for (const candidate of KNOWN_DEFAULT_PASSWORDS) {
      try {
        const result = await ctx.password.verify({ password: candidate, hash: account.password });
        if (result) {
          this.logger.warn(
            `检测到管理员 ${email} 仍在使用公开默认密码，请立即登录后台轮换为高强度密码！`,
          );
          return;
        }
      } catch (e) {
        this.logger.warn(`默认密码检查失败: ${(e as Error).message}`);
        return;
      }
    }
  }
}
