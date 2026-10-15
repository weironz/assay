import { create } from 'zustand';
import { api } from '../lib/api';
import type { TicketContact } from '../lib/contact';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  image: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  status: string;
  passwordSource?: 'local' | 'directory';
  /** 上次勾选「设为默认」存下的联系方式，建单时预填 */
  defaultContact: TicketContact | null;
  roles: string[];
  permissions: string[];
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** 仅在内存标记本次公司登录的可选文件服务结果，避免服务故障触发循环登录。 */
  directoryFilesReady: boolean | null;
  setDirectoryFilesReady: (ready: boolean | null) => void;
  /** 拉取当前会话用户（应用启动、登录后调用） */
  fetchMe: () => Promise<AuthUser | null>;
  setUser: (u: AuthUser | null) => void;
  clear: () => void;
  has: (perm: string) => boolean;
  hasRole: (role: string) => boolean;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  directoryFilesReady: null,
  setDirectoryFilesReady: (ready) => set({ directoryFilesReady: ready }),
  fetchMe: async () => {
    try {
      const { data } = await api.get<AuthUser>('/me');
      set((state) => ({
        user: data,
        loading: false,
        directoryFilesReady:
          state.user?.id === data.id ? state.directoryFilesReady : null,
      }));
      return data;
    } catch {
      set({ user: null, loading: false, directoryFilesReady: null });
      return null;
    }
  },
  setUser: (u) =>
    set((state) => ({
      user: u,
      loading: false,
      directoryFilesReady:
        u && state.user?.id === u.id ? state.directoryFilesReady : null,
    })),
  clear: () => set({ user: null, loading: false, directoryFilesReady: null }),
  has: (perm) => !!get().user?.permissions.includes(perm),
  hasRole: (role) => !!get().user?.roles.includes(role),
}));
