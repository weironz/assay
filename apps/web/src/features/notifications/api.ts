import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface Notification {
  id: string;
  type: string;
  title: string;
  content: string | null;
  isRead: boolean;
  ticketId: string | null;
  createdAt: string;
}

/** 未读数：每 20 秒轮询 */
export const useUnreadCount = () =>
  useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: async () =>
      (await api.get('/notifications/unread-count')).data.count as number,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

export const useNotifications = (enabled: boolean) =>
  useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: async () =>
      (await api.get('/notifications')).data as Notification[],
    enabled,
  });

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.patch(`/notifications/${id}/read`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post('/notifications/read-all')).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
