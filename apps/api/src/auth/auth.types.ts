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
  roles: string[]; // 角色名，如 ['admin']
  permissions: string[]; // 权限码集合，如 ['ticket:create', ...]
}
