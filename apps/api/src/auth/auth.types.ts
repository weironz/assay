import type { TicketContactDto } from '../tickets/contact';

/** 挂载到 request.user 上的登录用户信息（含 RBAC 角色与权限集） */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  image: string | null;
  emailVerified: boolean;
  status: string;
  /** 上次勾选「设为默认」存下的联系方式，建单时预填 */
  defaultContact: TicketContactDto | null;
  /** session 为 Web 登录；token 为 CLI / MCP / 自动化访问。 */
  authType: 'session' | 'token';
  /** Token 模式下的有效权限范围；用于审计和诊断，不包含原始密钥。 */
  tokenId?: string;
  tokenScopes?: string[];
  roles: string[]; // 角色名，如 ['admin']
  permissions: string[]; // 权限码集合，如 ['ticket:create', ...]
}
