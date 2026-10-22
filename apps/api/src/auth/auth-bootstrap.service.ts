import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { auth } from './auth';
import { assertSessionEpochMigration } from './session-epoch';
import { SYSTEM_ROLE_NAMES, SYSTEM_ROLE_PERMISSIONS } from './role-policy';

/** 仓库 .env.example / 部署模板中公开出现过的默认与占位口令（公开即高危，任何环境禁用） */
const KNOWN_PLACEHOLDER_PASSWORDS = new Set([
  'admin12345',
  'CHANGE_ME_admin_password',
  'please_set_a_strong_password',
]);

/** 启动时对存量管理员账号比对的已知公开默认口令（公开即高危，一律处理，不只在生产） */
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
    await this.assertRolePermissionsBaseline();
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
    // 不只刚处理的本机 ADMIN_EMAIL 账号：遍历全部 admin 角色的 credential 账号
    await this.enforceAdminPasswordRotation();
    this.logger.log(`管理员就绪: ${email}`);
  }

  /**
   * 角色→权限的运行真源在数据库（#23 后目录账号也读库）；SYSTEM_ROLE_PERMISSIONS
   * 只是 seed 的输入。启动时对比两边基线：DB 漏跑 seed、迁移失败或被人手工改动时，
   * 目录与本地登录会同时拿到漂移后的权限。生产直接拒绝启动逼着先跑 seed 校准，
   * 非生产只告警不阻断本地调试。
   */
  private async assertRolePermissionsBaseline() {
    const roles = await this.prisma.role.findMany({
      where: { name: { in: [...SYSTEM_ROLE_NAMES] } },
      select: { name: true, permissions: { include: { permission: true } } },
    });
    const stored = new Map(
      roles.map((role) => [role.name, new Set(role.permissions.map((rp) => rp.permission.code))]),
    );
    const drifted = SYSTEM_ROLE_NAMES.filter((name) => {
      const baseline = new Set(SYSTEM_ROLE_PERMISSIONS[name]);
      const actual = stored.get(name);
      return (
        !actual ||
        actual.size !== baseline.size ||
        [...baseline].some((code) => !actual.has(code))
      );
    });
    if (!drifted.length) return;
    const message =
      `数据库角色权限与代码基线不一致（${drifted.join('、')}）；` +
      '运行期的唯一真源在数据库，请先执行 seed 校准再上线';
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    this.logger.error(message);
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
   * 存量管理员账号的默认口令兜底：扫描全部 admin 角色用户的 credential 凭据，
   * 逐一与已知公开默认口令比对，而非只核对当前 ADMIN_EMAIL 匹配的那一个——
   * 早期默认路径（如 admin@example.com）创建的账号不会随 ADMIN_EMAIL 改名消失，
   * 漏扫它们等于把公网登录入口留给任何读过仓库的人。命中后续处理：
   * - 生产环境：立即轮换为一次性随机口令并自增该用户 sessionEpoch 使全部旧会话失效，
   *   新口令只在服务端日志打印一次，运维登录后必须立刻再改一次；
   * - 其他环境：对每个命中账号持续告警要求轮换，不擅自改本地开发库。
   * 比对在所有环境执行：默认口令公开可查，开发/测试机被扫到同样是事故。
   */
  private async enforceAdminPasswordRotation() {
    const accounts = await this.prisma.account.findMany({
      where: {
        providerId: 'credential',
        password: { not: null },
        user: { roles: { some: { role: { name: 'admin' } } } },
      },
      select: {
        id: true,
        password: true,
        user: { select: { id: true, email: true } },
      },
    });
    if (!accounts.length) return;
    const ctx = await auth.$context;
    for (const account of accounts) {
      if (!account.password) continue;
      let usesDefault = false;
      for (const candidate of KNOWN_DEFAULT_PASSWORDS) {
        try {
          if (await ctx.password.verify({ password: candidate, hash: account.password })) {
            usesDefault = true;
            break;
          }
        } catch (e) {
          this.logger.warn(`默认密码检查失败: ${(e as Error).message}`);
          break;
        }
      }
      if (!usesDefault) continue;
      if (process.env.NODE_ENV !== 'production') {
        this.logger.warn(
          `检测到管理员 ${account.user.email} 仍在使用公开默认密码，请勿保留到正式环境，立即轮换为高强度密码！`,
        );
        continue;
      }
      // 与 bootstrapPassword() 同款的临时口令：能登录，但绝不可能被猜到或公开查到。
      const rotated = randomBytes(18).toString('base64url');
      await this.prisma.$transaction([
        this.prisma.account.update({
          where: { id: account.id },
          data: { password: await ctx.password.hash(rotated) },
        }),
        this.prisma.user.update({
          where: { id: account.user.id },
          data: { sessionEpoch: { increment: 1 } },
        }),
      ]);
      this.logger.warn(
        `管理员 ${account.user.email} 的公开默认密码已被强制轮换并吊销全部旧会话，` +
          `临时密码为 ${rotated}（仅此一次打印，请立即登录后台改为高强度密码）`,
      );
    }
  }
}
