// Validate the exact submitted value. Naming policy never rewrites a user's input.
export function groupNameError(name: string, prefix: string, existing: string[], accounts: string[] = []) {
  if (!name) return '请输入用户组名称。';
  if (!/^[a-z][a-z0-9_-]{1,47}$/.test(name)) return '组名需为 2–48 个字符，以小写字母开头，仅包含小写字母、数字、下划线或短横线；不能包含空格。';
  if (['administrator', 'krbtgt', 'guest', 'domain_admins', 'sysvol', 'netlogon'].includes(name)) return '该名称为系统保留名，请使用其他用户组名称。';
  if (prefix && !name.startsWith(prefix)) return `当前部署仍配置了前缀 ${prefix}，请填写完整组名，或由部署管理员解除前缀限制。`;
  if (existing.some(item => item.toLowerCase() === name.toLowerCase())) return `用户组 ${name} 已存在，请使用其他名称。`;
  if (accounts.some(item => item.toLowerCase() === name.toLowerCase())) return `名称 ${name} 已被员工账号占用；AD 账号与用户组不能重名，请使用其他组名。`;
  return '';
}
