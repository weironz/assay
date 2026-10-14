/**
 * 系统岗位角色是权限模型的一部分，不开放给界面任意编排。
 * 新增或调整角色须随代码评审、测试与版本发布一起完成。
 */
export const SYSTEM_ROLE_NAMES = [
  'requester',
  'handler',
  'supervisor',
  'ticket_viewer_all',
  'asset_manager',
  'inventory_manager',
  'cop_viewer',
  'samba_manager',
  'admin',
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

export const SYSTEM_ROLE_DESCRIPTIONS: Record<SystemRoleName, string> = {
  requester: '提单人',
  handler: '处理人',
  supervisor: '主管',
  ticket_viewer_all: '工单观察员（全局只读）',
  asset_manager: '资产管理员',
  inventory_manager: '仓库管理员',
  cop_viewer: '运营平台观察员',
  samba_manager: '公司账号与文件共享管理员',
  admin: '管理员',
};

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleName, string[]> = {
  requester: [
    'ticket:create',
    'ticket:read',
    'ticket:update',
    'ticket:comment',
    'ticket:transition',
  ],
  handler: [
    'ticket:read',
    'ticket:update',
    'ticket:transition',
    'ticket:comment',
  ],
  supervisor: [
    'ticket:read',
    'ticket:read:all',
    'ticket:update',
    'ticket:assign',
    'ticket:transition',
    'ticket:comment',
    'stats:view',
  ],
  // 仅扩大全局阅读范围；工单操作仍由岗位角色与工单归属共同控制。
  ticket_viewer_all: ['ticket:read', 'ticket:read:all'],
  asset_manager: ['asset:read', 'asset:manage', 'platform:directory', 'ticket:read'],
  inventory_manager: ['inventory:read', 'inventory:manage', 'asset:read', 'platform:directory', 'ticket:read'],
  cop_viewer: ['asset:read', 'inventory:read', 'platform:directory'],
  samba_manager: ['samba:read', 'samba:manage'],
  admin: [
    'samba:read', 'samba:manage',
    'asset:read', 'asset:manage', 'inventory:read', 'inventory:manage', 'organization:manage', 'platform:directory',
    'ticket:create',
    'ticket:read',
    'ticket:read:all',
    'ticket:update',
    'ticket:assign',
    'ticket:transition',
    'ticket:comment',
    'queue:manage',
    'user:manage',
    'role:manage',
    'stats:view',
  ],
};

export function isSystemRoleName(name: string): name is SystemRoleName {
  return SYSTEM_ROLE_NAMES.includes(name as SystemRoleName);
}

export const PRIVILEGED_ROLE_NAMES = ['admin', 'supervisor', 'asset_manager', 'inventory_manager', 'samba_manager'] as const;
export const hasPrivilegedRole = (roles: string[]) => roles.some(role => (PRIVILEGED_ROLE_NAMES as readonly string[]).includes(role));
