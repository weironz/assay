import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDateFormat } from '../i18n/format';
import {
  useTickets,
  useQueues,
  useDeleteTicket,
  useSavedViews,
  useSaveView,
  useDeleteView,
  TicketQuery,
} from '../features/tickets/api';
import {
  STATUS_KEYS,
  STATUS_COLOR,
  PRIORITY_KEYS,
  PRIORITY_COLOR,
  statusLabel,
  priorityLabel,
  slaRailColor,
} from '../lib/ticket-meta';
import { useAuth } from '../stores/auth';
import { useCopy } from '../lib/use-copy';
import SlaBadge from '../components/SlaBadge';
import Toast from '../components/Toast';

export default function TicketsPage() {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  const has = useAuth((s) => s.has);
  const isAdmin = useAuth((s) => s.hasRole('admin'));
  const userId = useAuth((s) => s.user?.id);
  const { copy, copied } = useCopy();
  const [q, setQ] = useState<TicketQuery>({ page: 1, pageSize: 20 });
  const { data, isLoading } = useTickets(q);
  const { data: queues } = useQueues();
  const del = useDeleteTicket();
  const { data: views } = useSavedViews();
  const saveView = useSaveView();
  const delView = useDeleteView();

  const set = (patch: Partial<TicketQuery>) =>
    setQ((prev) => ({ ...prev, ...patch, page: 1 }));

  const applyView = (filter: TicketQuery) =>
    setQ({ ...filter, page: 1, pageSize: 20 });

  const saveCurrent = () => {
    const name = prompt(t('tickets.savePrompt'));
    if (!name?.trim()) return;
    const { page: _p, pageSize: _s, ...filter } = q;
    saveView.mutate({ name: name.trim(), filter });
  };

  const totalPages = data ? Math.ceil(data.total / (q.pageSize ?? 20)) : 1;

  return (
    <div className="space-y-4">
      <Toast show={copied} message={t('tickets.copied')} />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('tickets.title')}</h1>
        {has('ticket:create') && (
          <Link
            to="/tickets/new"
            className="rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800"
          >
            {t('tickets.new')}
          </Link>
        )}
      </div>

      {/* 保存的筛选视图 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => applyView({})}
          className="text-xs px-3 py-1 rounded-full border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {t('tickets.filterAll')}
        </button>
        {views?.map((v) => (
          <span
            key={v.id}
            className="group inline-flex items-center gap-1 text-xs px-3 py-1 rounded-full border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-950 text-brand-800 dark:text-brand-300"
          >
            <button onClick={() => applyView(v.filterJson)}>{v.name}</button>
            <button
              onClick={() => delView.mutate(v.id)}
              className="opacity-0 group-hover:opacity-100 text-brand-400 hover:text-red-500"
              title={t('tickets.deleteView')}
              aria-label={t('tickets.deleteView')}
            >
              ×
            </button>
          </span>
        ))}
        <button
          onClick={saveCurrent}
          className="text-xs px-3 py-1 rounded-full border border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          {t('tickets.saveView')}
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
        <input
          placeholder={t('tickets.searchPlaceholder')}
          aria-label={t('tickets.searchPlaceholder')}
          value={q.keyword ?? ''}
          onChange={(e) => set({ keyword: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        />
        <select
          value={q.status ?? ''}
          onChange={(e) => set({ status: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        >
          <option value="">{t('tickets.allStatuses')}</option>
          {STATUS_KEYS.map((k) => (
            <option key={k} value={k}>
              {statusLabel(t, k)}
            </option>
          ))}
        </select>
        <select
          value={q.priority ?? ''}
          onChange={(e) => set({ priority: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        >
          <option value="">{t('tickets.allPriorities')}</option>
          {PRIORITY_KEYS.map((k) => (
            <option key={k} value={k}>
              {priorityLabel(t, k)}
            </option>
          ))}
        </select>
        <select
          value={q.queueId ?? ''}
          onChange={(e) => set({ queueId: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        >
          <option value="">{t('tickets.allQueues')}</option>
          {queues?.map((qu: any) => (
            <option key={qu.id} value={qu.id}>
              {qu.name}
            </option>
          ))}
        </select>
      </div>

      {/* 列表 */}
      {/* overflow-x-auto 而非 hidden：列名长度随语言变化（"处理人" vs
          "ผู้รับผิดชอบ"），窄屏下应可横向滚动而不是把右侧列裁掉 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
        <table className="w-full min-w-[64rem] text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
            <tr>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colTicketNo')}</th>
              <th className="w-full px-4 py-2 text-left font-medium">{t('tickets.colTitle')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colCategory')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colStatus')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colSla')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colPriority')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colAssignee')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colRequester')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colCreatedAt')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-right font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {data?.items.map((ticket) => (
              <tr
                key={ticket.id}
                className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
              >
                <td
                  className="sla-rail whitespace-nowrap py-2 pl-4 pr-3"
                  style={
                    {
                      '--rail': slaRailColor(ticket.slaDueAt, ticket.status),
                    } as React.CSSProperties
                  }
                >
                  {/* 工单号点击复制：报障时最常做的动作就是把单号发给别人 */}
                  <button
                    type="button"
                    onClick={() => copy(ticket.ticketNo)}
                    title={t('tickets.copyTicketNo')}
                    aria-label={t('tickets.copyTicketNo')}
                    className="font-mono text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                  >
                    {ticket.ticketNo}
                  </button>
                </td>
                <td className="px-4 py-2">
                  {/* 蓝色是「可点进详情」的通用暗示，绿色是品牌色、在这里会和
                      状态标签抢注意力，所以链接单独用蓝 */}
                  <Link
                    to={`/tickets/${ticket.id}`}
                    className="font-medium text-sky-600 hover:underline dark:text-sky-400"
                  >
                    {ticket.title}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-600 dark:text-gray-300">
                  {ticket.category?.name ?? t('common.empty')}
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <span
                    className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs ${STATUS_COLOR[ticket.status]}`}
                  >
                    {statusLabel(t, ticket.status)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <SlaBadge slaDueAt={ticket.slaDueAt} status={ticket.status} />
                </td>
                <td className={`whitespace-nowrap px-4 py-2 text-sm ${PRIORITY_COLOR[ticket.priority]}`}>
                  {priorityLabel(t, ticket.priority)}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-600 dark:text-gray-300">
                  {ticket.assignee?.name ?? t('common.empty')}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-600 dark:text-gray-300">
                  {ticket.requester?.name}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-400">
                  {fmt.compact(ticket.createdAt)}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <Link
                    to={`/tickets/${ticket.id}`}
                    className="text-xs text-sky-600 hover:underline dark:text-sky-400"
                  >
                    {t('common.view')}
                  </Link>
                  {/* 管理员可删任意工单，提单人可删自己的 */}
                  {(isAdmin || ticket.requester?.id === userId) && (
                    <button
                      onClick={() => {
                        if (confirm(t('tickets.confirmDelete', { no: ticket.ticketNo })))
                          del.mutate(ticket.id);
                      }}
                      className="ml-3 text-red-500 text-xs hover:underline"
                    >
                      {t('common.delete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  {t('tickets.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {data && data.total > 0 && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <span className="text-gray-400">
            {t('tickets.pagination', {
              total: data.total,
              page: q.page ?? 1,
              pages: totalPages,
            })}
          </span>
          <button
            disabled={(q.page ?? 1) <= 1}
            onClick={() => setQ((p) => ({ ...p, page: (p.page ?? 1) - 1 }))}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40"
          >
            {t('tickets.prev')}
          </button>
          <button
            disabled={(q.page ?? 1) >= totalPages}
            onClick={() => setQ((p) => ({ ...p, page: (p.page ?? 1) + 1 }))}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40"
          >
            {t('tickets.next')}
          </button>
        </div>
      )}
    </div>
  );
}
