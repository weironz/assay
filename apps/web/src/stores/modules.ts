import { create } from 'zustand';
import { api } from '../lib/api';
export const useModules = create<{
  features: { directory: boolean; files: boolean };
  load: () => Promise<void>;
}>(set => ({
  features: { directory: false, files: false },
  load: async () => {
    try { const { data } = await api.get('/modules'); set({ features: { directory: data.directory === true, files: data.files === true } }); }
    catch { set({ features: { directory: false, files: false } }); }
  },
}));
