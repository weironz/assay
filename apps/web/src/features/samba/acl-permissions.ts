const permissions = [
  { value: 'read', label: '读取' },
  { value: 'write_no_delete', label: '读写（禁止删除）' },
  { value: 'modify', label: '修改（读写删除）' },
  { value: 'full', label: '完全控制（含权限管理）' },
  { value: 'remove', label: '移除直接授权' },
];
export function aclPermissionOptions(group: boolean, path: string) {
  return permissions.filter(p => (group || p.value !== 'full') && (!path || p.value !== 'write_no_delete'));
}
export function aclPermissionLabel(mask?: number) {
  if (mask === undefined) return undefined;
  return ({ 0x1f01ff: '完全控制', 0x1301bf: '修改', 0x1201bf: '读写（禁止删除）', 0x1200a9: '读取', 0x20000: '读取权限信息' } as Record<number, string>)[mask] || `0x${mask.toString(16)}`;
}
