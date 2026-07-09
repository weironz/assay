import axios from 'axios';

/** 后端 API 实例。所有 Nest 接口在 /api 前缀下；withCredentials 带会话 cookie。 */
// 用 ?? 而非 ||：生产单域名部署时 VITE_API_BASE_URL="" 表示相对路径（勿回退到 localhost）
const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
export const api = axios.create({
  baseURL: `${BASE}/api`,
  withCredentials: true,
});

// 401 时广播事件，由 App 统一清理登录态并跳转（避免与 store 循环依赖）
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const url: string = err.config?.url ?? '';
    // /me 的 401 是「未登录」正常探测，不触发跳转
    if (err.response?.status === 401 && !url.endsWith('/me')) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
    return Promise.reject(err);
  },
);
