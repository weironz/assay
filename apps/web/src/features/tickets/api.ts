import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TicketContact } from '../../lib/contact';

const API_BASE =
  (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000') + '/api';

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
/**
 * 上传的两种用途：inline 是正文里插的图（放宽到任意图片格式，截图常是 webp），
 * attachment 是显式添加的附件（受扩展名白名单约束）。服务端按 kind 分别校验。
 */
export type UploadKind = 'inline' | 'attachment';

export async function uploadAttachment(
  ticketId: string,
  file: File,
  messageId?: string,
  kind: UploadKind = 'attachment',
): Promise<Attachment> {
  const fd = new FormData();
  fd.append('file', file);
  const q = new URLSearchParams({ kind });
  if (messageId) q.set('messageId', messageId);
  const { data } = await api.post(`/tickets/${ticketId}/attachments?${q}`, fd);
  return data as Attachment;
}

/** 草稿上传：建单前上传（ticketId 暂空），提交时用 attachmentIds 关联 */
export async function uploadDraft(
  file: File,
  kind: UploadKind = 'attachment',
): Promise<Attachment> {
  const fd = new FormData();
  fd.append('file', file);
  const { data } = await api.post(`/uploads?kind=${kind}`, fd);
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
  author: {
    id: string;
    name: string;
    email: string;
    /** 头像相对路径，未设置时前端退化为姓名首字母 */
    image: string | null;
  };
}

export interface TicketDetail extends TicketListItem {
  messages: TicketMessage[];
  availableActions: string[];
  type: { id: string; name: string } | null;
  firstResponseAt: string | null;
  firstResponseDueAt: string | null;
  contact: TicketContact | null;
  datacenter: { id: string; name: string } | null;
  cluster: { id: string; name: string } | null;
  serialNumber: string | null;
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
      /** 下拉里没有合适分类时的自填名称，服务端负责去重/新建 */
      categoryName?: string;
      queueId?: string;
      datacenterId?: string;
      clusterId?: string;
      serialNumber?: string;
      contact?: TicketContact;
      saveContactAsDefault?: boolean;
      attachmentIds?: string[];
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
      qc.invalidateQueries({ queryKey: ['history', id] });
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

/** 编辑工单基本字段（标题/优先级/类型/分类/队列） */
export const useUpdateTicket = () =>
  useTicketMutation<Record<string, unknown>>((id, patch) =>
    api.patch(`/tickets/${id}`, patch),
  );

/** 编辑某条消息正文 */
export const useUpdateMessage = () =>
  useTicketMutation<{ messageId: string; body: string }>((id, arg) =>
    api.patch(`/tickets/${id}/messages/${arg.messageId}`, { body: arg.body }),
  );

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

export interface TicketType {
  id: string;
  name: string;
  /** 首次响应时限（分钟） */
  slaResponseMin: number;
  /** 解决时限（分钟） */
  slaResolveMin: number;
}

export const useTypes = () =>
  useQuery({
    queryKey: ['ticket-types'],
    queryFn: async () => (await api.get('/ticket-types')).data as TicketType[],
  });

/** 改 SLA 只影响之后新建的工单，在跑的工单截止时刻不变（见后端注释） */
export function useUpdateType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<TicketType> & { id: string }) =>
      (await api.patch(`/ticket-types/${id}`, patch)).data as TicketType,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket-types'] }),
  });
}

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: async () => (await api.get('/categories')).data,
  });

export const useDatacenters = () =>
  useQuery({
    queryKey: ['datacenters'],
    queryFn: async () =>
      (await api.get('/datacenters')).data as { id: string; name: string }[],
  });

export const useClusters = () =>
  useQuery({
    queryKey: ['clusters'],
    queryFn: async () =>
      (await api.get('/clusters')).data as {
        id: string;
        name: string;
        datacenterId: string | null;
      }[],
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
  /** 为空表示系统自动操作（如 SLA 超时升级优先级） */
  user: { id: string; name: string } | null;
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
