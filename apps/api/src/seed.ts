import { PrismaClient } from '@prisma/client';
import {
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
} from './auth/role-policy';

const prisma = new PrismaClient();

// 权限点清单
const PERMISSIONS: [string, string][] = [
  ['ticket:create', '创建工单'],
  ['ticket:read', '查看工单'],
  ['ticket:read:all', '查看全部工单'],
  ['ticket:update', '编辑工单'],
  ['ticket:assign', '指派工单'],
  ['ticket:transition', '流转工单状态'],
  ['ticket:comment', '回复/备注'],
  ['queue:manage', '管理队列'],
  ['user:manage', '管理用户'],
  ['role:manage', '管理角色'],
  ['stats:view', '查看统计'],
];

async function main() {
  // 权限
  for (const [code, name] of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: { name },
      create: { code, name },
    });
  }

  // 固定岗位角色 + 固定权限。每次 seed 均按代码基线校准，避免页面配置漂移。
  for (const roleName of SYSTEM_ROLE_NAMES) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: { description: SYSTEM_ROLE_DESCRIPTIONS[roleName] },
      create: { name: roleName, description: SYSTEM_ROLE_DESCRIPTIONS[roleName] },
    });
    const permissionCodes = SYSTEM_ROLE_PERMISSIONS[roleName];
    const permissions = await prisma.permission.findMany({
      where: { code: { in: permissionCodes } },
    });
    if (permissions.length !== permissionCodes.length) {
      throw new Error(`角色 ${roleName} 存在未定义的权限码`);
    }
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
      prisma.rolePermission.createMany({
        data: permissions.map((permission) => ({
          roleId: role.id,
          permissionId: permission.id,
        })),
      }),
    ]);
  }

  // 管理员账号由 api 启动时的 AuthBootstrapService 通过 better-auth 创建
  // （这样密码经 better-auth 正确哈希，能真正登录）

  // 默认队列
  await prisma.queue.upsert({
    where: { name: '默认队列' },
    update: {},
    create: { name: '默认队列', description: '未分类工单默认归属' },
  });

  // 示例工单类型（含 SLA 时限）
  const types = [
    { name: '故障', slaResponseMin: 30, slaResolveMin: 480 },
    { name: '需求', slaResponseMin: 120, slaResolveMin: 2880 },
    { name: '咨询', slaResponseMin: 60, slaResolveMin: 1440 },
  ];
  for (const t of types) {
    await prisma.ticketType.upsert({
      where: { name: t.name },
      update: {},
      create: t,
    });
  }

  // 分类：按名字逐个补齐，而不是「表空才建」。
  // 老库不会因为已有分类就永远拿不到新增项——这批 IDC 分类就是这么加进去的。
  // 只增不删：删分类会连带影响已挂在上面的历史工单，得由人工决定。
  const ensureCategory = async (name: string, parentId?: string) => {
    const found = await prisma.category.findFirst({ where: { name } });
    if (found) return found;
    return prisma.category.create({ data: { name, parentId } });
  };

  const it = await ensureCategory('IT 支持');
  for (const name of ['网络', '账号权限', '软件安装']) {
    await ensureCategory(name, it.id);
  }
  // IDC 算力租赁场景的报障对象
  for (const name of ['IB 网络', '以太网网络', 'GPU 卡', 'B300']) {
    await ensureCategory(name);
  }

  // 机房与集群
  const dz = await prisma.datacenter.upsert({
    where: { name: 'datazone' },
    update: {},
    create: { name: 'datazone' },
  });
  for (const name of ['BKK-CL01', 'BKK-CL02']) {
    await prisma.cluster.upsert({
      where: { name },
      update: {},
      create: { name, datacenterId: dz.id },
    });
  }

  console.log('✅ Seed 完成：权限/角色/admin/默认队列/类型/分类/机房集群');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
