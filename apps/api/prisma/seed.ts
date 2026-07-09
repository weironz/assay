import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 权限点清单
const PERMISSIONS: [string, string][] = [
  ['ticket:create', '创建工单'],
  ['ticket:read', '查看工单'],
  ['ticket:update', '编辑工单'],
  ['ticket:assign', '指派工单'],
  ['ticket:transition', '流转工单状态'],
  ['ticket:comment', '回复/备注'],
  ['queue:manage', '管理队列'],
  ['user:manage', '管理用户'],
  ['role:manage', '管理角色'],
  ['stats:view', '查看统计'],
];

// 角色 -> 权限
const ROLE_PERMS: Record<string, string[]> = {
  requester: [
    'ticket:create',
    'ticket:read',
    'ticket:comment',
    'ticket:transition', // 关单/重开/取消（具体动作由 WorkflowService 细粒度控制）
  ],
  handler: [
    'ticket:read',
    'ticket:update',
    'ticket:transition',
    'ticket:comment',
  ],
  supervisor: [
    'ticket:read',
    'ticket:update',
    'ticket:assign',
    'ticket:transition',
    'ticket:comment',
    'stats:view',
  ],
  admin: PERMISSIONS.map((p) => p[0]),
};

const ROLE_DESC: Record<string, string> = {
  requester: '提单人',
  handler: '处理人',
  supervisor: '主管',
  admin: '管理员',
};

async function main() {
  // 权限
  for (const [code, name] of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: { name },
      create: { code, name },
    });
  }

  // 角色 + 角色权限
  for (const roleName of Object.keys(ROLE_PERMS)) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: { description: ROLE_DESC[roleName] },
      create: { name: roleName, description: ROLE_DESC[roleName] },
    });
    for (const code of ROLE_PERMS[roleName]) {
      const perm = await prisma.permission.findUnique({ where: { code } });
      if (perm) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: { roleId: role.id, permissionId: perm.id },
          },
          update: {},
          create: { roleId: role.id, permissionId: perm.id },
        });
      }
    }
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

  // 示例分类树（仅当没有分类时创建，保证幂等）
  const catCount = await prisma.category.count();
  if (catCount === 0) {
    const it = await prisma.category.create({ data: { name: 'IT 支持' } });
    await prisma.category.createMany({
      data: [
        { name: '网络', parentId: it.id },
        { name: '账号权限', parentId: it.id },
        { name: '软件安装', parentId: it.id },
      ],
    });
  }

  console.log('✅ Seed 完成：权限/角色/admin/默认队列/类型/分类');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
