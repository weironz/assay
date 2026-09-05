/**
 * 系统岗位角色是权限模型的一部分，不开放给界面任意编排。
 * 新增或调整角色须随代码评审、测试与版本发布一起完成。
 */
export const SYSTEM_ROLE_NAMES = [
  'requester',
  'handler',
  'supervisor',
  'ticket_viewer_all',
  'admin',
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

export const SYSTEM_ROLE_DESCRIPTIONS: Record<SystemRoleName, string> = {
  requester: '提单人',
  handler: '处理人',
  supervisor: '主管',
  ticket_viewer_all: '工单观察员（全局只读）',
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
  admin: [
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
