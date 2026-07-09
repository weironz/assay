/** 挂载到 request.user 上的登录用户信息（含 RBAC 角色与权限集） */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  status: string;
  roles: string[]; // 角色名，如 ['admin']
  permissions: string[]; // 权限码集合，如 ['ticket:create', ...]
}
