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
  status: string;
  /** 上次勾选「设为默认」存下的联系方式，建单时预填 */
  defaultContact: TicketContact | null;
  roles: string[];
  permissions: string[];
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
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
  fetchMe: async () => {
    try {
      const { data } = await api.get<AuthUser>('/me');
      set({ user: data, loading: false });
      return data;
    } catch {
      set({ user: null, loading: false });
      return null;
    }
  },
  setUser: (u) => set({ user: u, loading: false }),
  clear: () => set({ user: null, loading: false }),
  has: (perm) => !!get().user?.permissions.includes(perm),
  hasRole: (role) => !!get().user?.roles.includes(role),
}));
