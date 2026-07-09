import { createAuthClient } from 'better-auth/react';

/** better-auth 前端客户端：负责登录/登出/会话（走 cookie） */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
  basePath: '/api/auth',
});

export const { signIn, signOut } = authClient;
