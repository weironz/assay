import axios from 'axios';

/** 后端 API 实例。withCredentials 让浏览器带上会话 cookie。 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
  withCredentials: true,
});

// 401 时广播事件，由 App 统一清理登录态并跳转（避免与 store 循环依赖）
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const url: string = err.config?.url ?? '';
    // /auth/me 的 401 是「未登录」正常探测，不触发跳转
    if (err.response?.status === 401 && !url.includes('/auth/me')) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
    return Promise.reject(err);
  },
);
