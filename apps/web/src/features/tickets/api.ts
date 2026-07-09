import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export interface Attachment {
  id: string;
  fileName: string;
  fileSize: number;
  mime: string;
  url: string; // 相对路径 /attachments/:id/download
}

/** 绝对下载地址（供 <img> / 下载链接直接使用，带会话 cookie） */
export const attachmentUrl = (a: Attachment | string) =>
  API_BASE + (typeof a === 'string' ? a : a.url);

/** 上传附件（含内联图片），返回记录；图片用 attachmentUrl(rec.url) 作 src */
export async function uploadAttachment(
  ticketId: string,
  file: File,
  messageId?: string,
): Promise<Attachment> {
  const fd = new FormData();
  fd.append('file', file);
  const q = messageId ? `?messageId=${messageId}` : '';
  const { data } = await api.post(`/tickets/${ticketId}/attachments${q}`, fd);
  return data as Attachment;
}

// —— 逻辑层：数据请求 hooks（界面组件只调用，不含 fetch 细节）——

export interface TicketListItem {
  id: string;
  ticketNo: string;
  title: string;
  status: string;
  priority: string;
  requester: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  queue: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  createdAt: string;
  slaDueAt: string | null;
}

export interface TicketMessage {
  id: string;
  body: string;
  type: string;
  isInternal: boolean;
  contentType: string;
  createdAt: string;
  author: { id: string; name: string };
}

export interface TicketDetail extends TicketListItem {
  messages: TicketMessage[];
  availableActions: string[];
  type: { id: string; name: string } | null;
  firstResponseAt: string | null;
}

export interface TicketQuery {
  status?: string;
  priority?: string;
  queueId?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export function useTickets(q: TicketQuery) {
  return useQuery({
    queryKey: ['tickets', q],
    queryFn: async () =>
      (await api.get('/tickets', { params: q })).data as {
        items: TicketListItem[];
        total: number;
        page: number;
        pageSize: number;
      },
  });
}

export function useTicket(id: string) {
  return useQuery({
    queryKey: ['ticket', id],
    queryFn: async () => (await api.get(`/tickets/${id}`)).data as TicketDetail,
    enabled: !!id,
  });
}

export function useCreateTicket() {
  return useMutation({
    mutationFn: async (body: {
      title: string;
      body: string;
      priority?: string;
      typeId?: string;
      categoryId?: string;
      queueId?: string;
    }) => (await api.post('/tickets', body)).data as TicketDetail,
  });
}

function useTicketMutation<T>(fn: (id: string, arg: T) => Promise<any>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, arg }: { id: string; arg: T }) => fn(id, arg),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: ['ticket', id] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
}

export const useTransition = () =>
  useTicketMutation<string>((id, action) =>
    api.post(`/tickets/${id}/transition`, { action }),
  );

export function useDeleteTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/tickets/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }),
  });
}

export const useAssign = () =>
  useTicketMutation<{ assigneeId: string; queueId?: string }>((id, arg) =>
    api.post(`/tickets/${id}/assign`, arg),
  );

export const useAddMessage = () =>
  useTicketMutation<{ body: string; isInternal?: boolean }>((id, arg) =>
    api.post(`/tickets/${id}/messages`, arg),
  );

// —— 元数据 ——
export const useQueues = () =>
  useQuery({
    queryKey: ['queues'],
    queryFn: async () => (await api.get('/queues')).data,
  });

export const useTypes = () =>
  useQuery({
    queryKey: ['ticket-types'],
    queryFn: async () => (await api.get('/ticket-types')).data,
  });

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: async () => (await api.get('/categories')).data,
  });

export const useAssignees = () =>
  useQuery({
    queryKey: ['assignees'],
    queryFn: async () =>
      (await api.get('/assignees')).data as { id: string; name: string }[],
  });

export const useAttachments = (ticketId: string) =>
  useQuery({
    queryKey: ['attachments', ticketId],
    queryFn: async () =>
      (await api.get(`/tickets/${ticketId}/attachments`)).data as Attachment[],
    enabled: !!ticketId,
  });

export interface HistoryEntry {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  user: { id: string; name: string };
}

export const useHistory = (ticketId: string) =>
  useQuery({
    queryKey: ['history', ticketId],
    queryFn: async () =>
      (await api.get(`/tickets/${ticketId}/history`)).data as HistoryEntry[],
    enabled: !!ticketId,
  });

// —— 保存筛选视图 ——
export interface SavedView {
  id: string;
  name: string;
  filterJson: TicketQuery;
  isShared: boolean;
  userId: string;
}

export const useSavedViews = () =>
  useQuery({
    queryKey: ['saved-views'],
    queryFn: async () => (await api.get('/saved-views')).data as SavedView[],
  });

export function useSaveView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { name: string; filter: TicketQuery; isShared?: boolean }) =>
      (await api.post('/saved-views', v)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views'] }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/saved-views/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-views'] }),
  });
}
