import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDateFormat } from '../i18n/format';
import {
  useTickets,
  useQueues,
  useCategories,
  useTicketFilterPeople,
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

const TICKET_SCOPES: NonNullable<TicketQuery['scope']>[] = [
  'open',
  'completed',
  'mine',
  'unassigned',
  'overdue',
];

function scopeFromSearch(value: string | null): TicketQuery['scope'] {
  return TICKET_SCOPES.includes(value as NonNullable<TicketQuery['scope']>)
    ? (value as TicketQuery['scope'])
    : undefined;
}

export default function TicketsPage() {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  const has = useAuth((s) => s.has);
  const isAdmin = useAuth((s) => s.hasRole('admin'));
  const userId = useAuth((s) => s.user?.id);
  const { copy, copied } = useCopy();
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState<TicketQuery>(() => ({
    status: searchParams.get('status') || undefined,
    scope: scopeFromSearch(searchParams.get('scope')),
    priority: searchParams.get('priority') || undefined,
    queueId: searchParams.get('queueId') || undefined,
    assigneeId: searchParams.get('assigneeId') || undefined,
    requesterId: searchParams.get('requesterId') || undefined,
    categoryId: searchParams.get('categoryId') || undefined,
    ticketNo: searchParams.get('ticketNo') || undefined,
    keyword: searchParams.get('keyword') || undefined,
    page: Number(searchParams.get('page')) || 1,
    pageSize: Number(searchParams.get('pageSize')) || 20,
  }));
  const { data, isLoading } = useTickets(q);
  const { data: queues } = useQueues();
  const { data: categories } = useCategories();
  const { data: filterPeople } = useTicketFilterPeople();
  const del = useDeleteTicket();
  const { data: views } = useSavedViews();
  const saveView = useSaveView();
  const delView = useDeleteView();

  const syncQuery = (next: TicketQuery) => {
    setQ(next);
    const params = new URLSearchParams();
    (['status', 'scope', 'priority', 'queueId', 'assigneeId', 'requesterId', 'categoryId', 'ticketNo', 'keyword'] as const).forEach(
      (key) => {
        if (next[key]) params.set(key, next[key]!);
      },
    );
    if ((next.page ?? 1) > 1) params.set('page', String(next.page));
    if ((next.pageSize ?? 20) !== 20) params.set('pageSize', String(next.pageSize));
    setSearchParams(params, { replace: true });
  };

  const set = (patch: Partial<TicketQuery>) =>
    syncQuery({ ...q, ...patch, page: 1 });

  const applyView = (filter: TicketQuery) =>
    syncQuery({ ...filter, page: 1, pageSize: 20 });

  const saveCurrent = () => {
    const name = prompt(t('tickets.savePrompt'));
    if (!name?.trim()) return;
    const { page: _p, pageSize: _s, ...filter } = q;
    saveView.mutate({ name: name.trim(), filter });
  };

  const totalPages = data ? Math.ceil(data.total / (q.pageSize ?? 20)) : 1;
  const scopeLabel = q.scope
    ? {
        open: t('dashboard.open'),
        completed: t('dashboard.done'),
        mine: t('dashboard.myTodo'),
        unassigned: t('dashboard.unassigned'),
        overdue: t('dashboard.overdue'),
      }[q.scope]
    : null;
  const statusFilterValue =
    q.scope === 'open'
      ? '__open__'
      : q.scope === 'completed'
        ? '__completed__'
        : q.status ?? '';
  const setStatusFilter = (value: string) => {
    if (value === '__open__') set({ status: undefined, scope: 'open' });
    else if (value === '__completed__') set({ status: undefined, scope: 'completed' });
    else set({ status: value || undefined, scope: undefined });
  };

  const filterControlClass =
    'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm font-normal text-gray-900 shadow-sm outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-brand-500 dark:focus:ring-brand-900';

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
        {scopeLabel && (
          <button
            onClick={() => set({ scope: undefined })}
            className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs text-brand-800 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900"
            aria-label={t('tickets.filterAll')}
          >
            {scopeLabel} <span aria-hidden="true">×</span>
          </button>
        )}
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

      {/* 移动端保留独立筛选栏；桌面筛选控件直接位于对应的表头。 */}
      <div className="flex flex-wrap gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900 lg:hidden">
        <label className="min-w-48 flex-1">
          <span className="sr-only">{t('tickets.titlePlaceholder')}</span>
          <input
            placeholder={t('tickets.titlePlaceholder')}
            value={q.keyword ?? ''}
            onChange={(e) => set({ keyword: e.target.value || undefined })}
            className={filterControlClass}
          />
        </label>
        <label>
          <span className="sr-only">{t('tickets.colStatus')}</span>
          <select value={statusFilterValue} onChange={(e) => setStatusFilter(e.target.value)} className={filterControlClass}>
            <option value="">{t('tickets.allStatuses')}</option>
            <option value="__open__">{t('dashboard.open')}</option>
            <option value="__completed__">{t('dashboard.done')}</option>
            {STATUS_KEYS.map((k) => (
              <option key={k} value={k}>{statusLabel(t, k)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t('tickets.colPriority')}</span>
          <select value={q.priority ?? ''} onChange={(e) => set({ priority: e.target.value || undefined })} className={filterControlClass}>
            <option value="">{t('tickets.allPriorities')}</option>
            {PRIORITY_KEYS.map((k) => (
              <option key={k} value={k}>{priorityLabel(t, k)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t('tickets.colCategory')}</span>
          <select value={q.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || undefined })} className={filterControlClass}>
            <option value="">{t('tickets.filterAll')} {t('tickets.colCategory')}</option>
            {categories?.map((category: any) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t('ticketNew.queue')}</span>
          <select value={q.queueId ?? ''} onChange={(e) => set({ queueId: e.target.value || undefined })} className={filterControlClass}>
            <option value="">{t('tickets.allQueues')}</option>
            {queues?.map((queue: any) => (
              <option key={queue.id} value={queue.id}>{queue.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t('tickets.colAssignee')}</span>
          <select value={q.assigneeId ?? ''} onChange={(e) => set({ assigneeId: e.target.value || undefined })} className={filterControlClass}>
            <option value="">{t('tickets.allAssignees')}</option>
            {filterPeople?.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t('tickets.colRequester')}</span>
          <select value={q.requesterId ?? ''} onChange={(e) => set({ requesterId: e.target.value || undefined })} className={filterControlClass}>
            <option value="">{t('tickets.allRequesters')}</option>
            {filterPeople?.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </label>
      </div>

      {/* 手机：卡片列表。多列的表格在 375px 屏上只能左右拖着看，
          等于没法用；改成每单一张卡，把最要紧的几项竖排出来。
          桌面仍用表格——宽屏下表格的对齐和扫读效率是卡片比不了的 */}
      <div className="space-y-2 lg:hidden">
        {isLoading && (
          <p className="py-8 text-center text-gray-400">{t('common.loading')}</p>
        )}
        {data?.items.map((ticket) => (
          <div
            key={ticket.id}
            className="sla-rail rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900"
            style={
              {
                '--rail': slaRailColor(ticket.slaDueAt, ticket.status),
              } as React.CSSProperties
            }
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs ${STATUS_COLOR[ticket.status]}`}
              >
                {statusLabel(t, ticket.status)}
              </span>
              <span className={`text-xs ${PRIORITY_COLOR[ticket.priority]}`}>
                {priorityLabel(t, ticket.priority)}
              </span>
              <span className="ml-auto">
                <SlaBadge slaDueAt={ticket.slaDueAt} status={ticket.status} />
              </span>
            </div>
            <Link
              to={`/tickets/${ticket.id}`}
              className="block font-medium text-sky-600 dark:text-sky-400"
            >
              {ticket.title}
            </Link>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
              <button
                type="button"
                onClick={() => copy(ticket.ticketNo)}
                title={t('tickets.copyTicketNo')}
                className="font-mono"
              >
                {ticket.ticketNo}
              </button>
              {ticket.category && <span>· {ticket.category.name}</span>}
              <span>· {fmt.compact(ticket.createdAt)}</span>
            </div>
            <div className="mt-2 flex items-center gap-3 border-t border-gray-100 pt-2 text-xs dark:border-gray-800">
              <span className="text-gray-400">
                {ticket.assignee?.name ?? t('ticketDetail.unassigned')}
              </span>
              <Link
                to={`/tickets/${ticket.id}`}
                className="ml-auto text-sky-600 dark:text-sky-400"
              >
                {t('common.view')}
              </Link>
              {(isAdmin || ticket.requester?.id === userId) && (
                <button
                  onClick={() => {
                    if (confirm(t('tickets.confirmDelete', { no: ticket.ticketNo })))
                      del.mutate(ticket.id);
                  }}
                  className="text-red-500"
                >
                  {t('common.delete')}
                </button>
              )}
            </div>
          </div>
        ))}
        {data && data.items.length === 0 && (
          <p className="py-8 text-center text-gray-400">{t('tickets.empty')}</p>
        )}
      </div>

      {/* 桌面：表格 */}
      {/* overflow-x-auto 而非 hidden：列名长度随语言变化（"处理人" vs
          "ผู้รับผิดชอบ"），窄屏下应可横向滚动而不是把右侧列裁掉 */}
      <div className="hidden bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto lg:block">
        <table className="w-full min-w-[88rem] text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
            <tr>
              <th className="w-36 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('tickets.colTicketNo')}</span>
                  <input
                    placeholder={t('tickets.ticketNoPlaceholder')}
                    aria-label={t('tickets.ticketNoPlaceholder')}
                    value={q.ticketNo ?? ''}
                    onChange={(e) => set({ ticketNo: e.target.value || undefined })}
                    className={`mt-1 ${filterControlClass}`}
                  />
                </label>
              </th>
              <th className="w-72 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('tickets.colTitle')}</span>
                  <input
                    placeholder={t('tickets.titlePlaceholder')}
                    aria-label={t('tickets.titlePlaceholder')}
                    value={q.keyword ?? ''}
                    onChange={(e) => set({ keyword: e.target.value || undefined })}
                    className={`mt-1 ${filterControlClass}`}
                  />
                </label>
              </th>
              <th className="w-32 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('tickets.colCategory')}</span>
                  <select value={q.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || undefined })} className={`mt-1 ${filterControlClass}`}>
                    <option value="">{t('tickets.filterAll')}</option>
                    {categories?.map((category: any) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </select>
                </label>
              </th>
              <th className="w-32 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('ticketNew.queue')}</span>
                  <select value={q.queueId ?? ''} onChange={(e) => set({ queueId: e.target.value || undefined })} className={`mt-1 ${filterControlClass}`}>
                    <option value="">{t('tickets.filterAll')}</option>
                    {queues?.map((queue: any) => (
                      <option key={queue.id} value={queue.id}>{queue.name}</option>
                    ))}
                  </select>
                </label>
              </th>
              <th className="w-32 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('tickets.colStatus')}</span>
                  <select value={statusFilterValue} onChange={(e) => setStatusFilter(e.target.value)} className={`mt-1 ${filterControlClass}`}>
                    <option value="">{t('tickets.allStatuses')}</option>
                    <option value="__open__">{t('dashboard.open')}</option>
                    <option value="__completed__">{t('dashboard.done')}</option>
                    {STATUS_KEYS.map((k) => (
                      <option key={k} value={k}>{statusLabel(t, k)}</option>
                    ))}
                  </select>
                </label>
              </th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colSla')}</th>
              <th className="w-28 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('tickets.colPriority')}</span>
                  <select value={q.priority ?? ''} onChange={(e) => set({ priority: e.target.value || undefined })} className={`mt-1 ${filterControlClass}`}>
                    <option value="">{t('tickets.allPriorities')}</option>
                    {PRIORITY_KEYS.map((k) => (
                      <option key={k} value={k}>{priorityLabel(t, k)}</option>
                    ))}
                  </select>
                </label>
              </th>
              <th className="w-32 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('tickets.colAssignee')}</span>
                  <select value={q.assigneeId ?? ''} onChange={(e) => set({ assigneeId: e.target.value || undefined })} className={`mt-1 ${filterControlClass}`}>
                    <option value="">{t('tickets.allAssignees')}</option>
                    {filterPeople?.map((person) => (
                      <option key={person.id} value={person.id}>{person.name}</option>
                    ))}
                  </select>
                </label>
              </th>
              <th className="w-32 px-4 py-2 text-left font-medium">
                <label className="block">
                  <span>{t('tickets.colRequester')}</span>
                  <select value={q.requesterId ?? ''} onChange={(e) => set({ requesterId: e.target.value || undefined })} className={`mt-1 ${filterControlClass}`}>
                    <option value="">{t('tickets.allRequesters')}</option>
                    {filterPeople?.map((person) => (
                      <option key={person.id} value={person.id}>{person.name}</option>
                    ))}
                  </select>
                </label>
              </th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">{t('tickets.colCreatedAt')}</th>
              <th className="whitespace-nowrap px-4 py-2 text-right font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
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
                <td className="whitespace-nowrap px-4 py-2 text-gray-600 dark:text-gray-300">
                  {ticket.queue?.name ?? t('common.empty')}
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
            onClick={() => syncQuery({ ...q, page: (q.page ?? 1) - 1 })}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40"
          >
            {t('tickets.prev')}
          </button>
          <button
            disabled={(q.page ?? 1) >= totalPages}
            onClick={() => syncQuery({ ...q, page: (q.page ?? 1) + 1 })}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40"
          >
            {t('tickets.next')}
          </button>
        </div>
      )}
    </div>
  );
}
