// Only fixed application messages are displayed. Protocol diagnostics never
// become dialog content, including errors returned by an older/unknown agent.
const messages: Record<string, string> = {
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
