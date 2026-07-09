import { createAuthClient } from 'better-auth/react';

/** better-auth 前端客户端：负责登录/登出/会话（走 cookie） */
// "" → 当前站点 origin（生产单域名）；未设置 → dev 默认
const AUTH_BASE =
  (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000') ||
  window.location.origin;
export const authClient = createAuthClient({
  baseURL: AUTH_BASE,
  basePath: '/api/auth',
});

export const { signIn, signOut } = authClient;
