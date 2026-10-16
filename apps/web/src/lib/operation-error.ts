// Only fixed application messages are displayed. Protocol diagnostics never
// become dialog content, including errors returned by an older/unknown agent.
const messages: Record<string, string> = {
  RENAME_INVALID_NAME:'名称参数无效，请使用 2–48 个字符，以小写字母开头，仅包含小写字母、数字、下划线或短横线。',
  RENAME_PROTECTED:'系统共享或打印机扫描入口受到保护，不能通过此操作改名。',
  RENAME_CONFLICT:'资源或配置已被其他操作修改，请刷新后重新预检查。',
  RENAME_NAME_EXISTS:'名称已被占用。AD 员工账号和用户组不能重名，共享名称也不能重复。',
  RENAME_UNCHANGED:'新旧名称相同，请填写不同的新名称。',
  RENAME_NOT_CONFIGURED:'当前部署尚未启用安全重命名，请由部署管理员完成升级配置。',
  RENAME_OBJECT_NOT_FOUND:'原对象已不存在或不在管理范围内，请刷新列表。',
  RENAME_CONFIG_INVALID:'Samba 配置验证失败，尚未执行重命名，请检查服务端操作记录。',
  RENAME_CONNECTION_ACK_REQUIRED:'当前存在 SMB 连接，请重新预检查并确认连接影响。',
  RENAME_RECOVERY_REQUIRED:'重命名结果需要恢复核对，已暂停进一步管理写入。请联系管理员查看恢复记录，不要重复提交。',
  RENAME_ROLLED_BACK:'操作中断后已恢复原名称和配置，请刷新核对后重新操作。',
  SAMBA_GROUP_ACCOUNT_NAME_EXISTS: '名称已被员工账号占用；AD 账号与用户组不能重名，请使用其他组名。',
  AD_OBJECT_EXISTS: '名称或目录对象已在 AD 中被占用，请刷新核对并使用其他名称。',
  SAMBA_GROUP_NAME_PROTECTED: '该名称为系统保留名，请使用其他用户组名称。',
  SAMBA_GROUP_NAME_INVALID: '完整组名需为 2–48 个字符，以小写字母开头，仅包含小写字母、数字、下划线或短横线。',
  SAMBA_GROUP_PREFIX_REQUIRED: '用户组名称不符合当前配置的前缀要求，请刷新页面确认最新命名规则后重新提交。',
  SAMBA_GROUP_NAME_EXISTS: '用户组名称已存在，请刷新列表或使用其他名称。',
  SAMBA_GROUP_POLICY_UNAVAILABLE: '无法读取用户组命名规则，请刷新页面或检查目录服务后重试。',
  AD_PASSWORD_COMPLEXITY: '新密码不符合公司 AD 的复杂度要求。请组合使用大小写字母、数字或符号，并避免包含账号或姓名。',
  AD_PASSWORD_HISTORY: '新密码与近期使用过的密码重复，请换一个未使用过的密码。',
  AD_PASSWORD_TOO_SHORT: '新密码长度不足，请按公司 AD 的最小密码长度要求设置。',
  AD_PASSWORD_TOO_RECENT: '密码修改间隔未达到公司 AD 的要求，请联系管理员检查最短密码使用期限。',
  AD_PASSWORD_POLICY: '新密码被公司 AD 的密码策略拒绝。请检查长度、复杂度及历史密码要求后重新设置。',
  AD_PASSWORD_REJECTED: 'AD 拒绝更改密码，尚未确认具体原因。请检查密码策略、管理权限及安全连接配置，并核对操作记录。',
  AD_CURRENT_PASSWORD_INVALID: '当前 AD 密码不正确，请重新输入。',
  AD_PERMISSION_DENIED: 'AD 拒绝此操作：管理服务账号权限不足，请检查 AD 的权限委派。',
  AD_AUTHENTICATION_FAILED: 'AD 管理服务身份验证失败，请检查服务账号及凭据配置。',
  AD_SECURE_CHANNEL_REQUIRED: 'AD 要求使用安全连接，请检查管理服务的 LDAPS 配置及证书。',
  AD_UNAVAILABLE: '公司 AD 服务暂时不可用，请检查域控运行状态。',
  AD_CONNECTION_FAILED: '无法连接公司 AD，请检查域控服务、网络及证书配置。',
  AD_OPERATION_REJECTED: 'AD 拒绝此操作，请核对账号权限、目录策略及操作记录。',
};

export class OperationError extends Error {
  constructor(readonly code?: string | null) {
    super(code && Object.hasOwn(messages, code) ? messages[code] : '操作未完成，请核对操作记录与资源状态。');
    this.name = 'OperationError';
  }
}
