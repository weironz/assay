import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface Overview {
  total: number;
  open: number;
  myTodo: number;
  overdue: number;
  unassigned: number;
  unread: number;
  byStatus: Record<string, number>;
}

export const useOverview = () =>
  useQuery({
    queryKey: ['stats', 'overview'],
    queryFn: async () => (await api.get('/stats/overview')).data as Overview,
    refetchInterval: 30_000,
  });
