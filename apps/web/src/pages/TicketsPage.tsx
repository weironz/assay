import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDateFormat } from '../i18n/format';
import {
  useTickets,
  useQueues,
  useCategories,
  useDatacenters,
  useTicketFilterPeople,
  useDeleteTicket,
  useSavedViews,
  useSaveView,
  useDeleteView,
  type TicketQuery,
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
import {
  ticketQueryFromSearch,
  ticketQuerySearch,
  dateBoundary,
  boundaryDate,
} from '../lib/ticket-query';
import { useAuth } from '../stores/auth';
import { useCopy } from '../lib/use-copy';
import { metadataLabel } from '../lib/metadata-labels';
import ColumnFilter from '../components/ColumnFilter';
import SlaBadge from '../components/SlaBadge';
import Toast from '../components/Toast';

const input =
  'min-h-11 w-full min-w-0 rounded-md border border-gray-300 bg-white px-3 text-sm font-normal text-gray-900 focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export default function TicketsPage() {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  const has = useAuth((s) => s.has);
  const isAdmin = useAuth((s) => s.hasRole('admin'));
  const userId = useAuth((s) => s.user?.id);
  const { copy, copied } = useCopy();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = ticketQueryFromSearch(searchParams);
  const { data, isLoading, isError, refetch } = useTickets(q);
  const { data: queues } = useQueues();
  const { data: categories } = useCategories();
  const { data: datacenters } = useDatacenters();
  const { data: filterPeople } = useTicketFilterPeople();
  const del = useDeleteTicket();
  const { data: views } = useSavedViews();
  const saveView = useSaveView();
  const delView = useDeleteView();
  const syncQuery = (next: TicketQuery) =>
    setSearchParams(ticketQuerySearch(next), { replace: true });
  const set = (patch: Partial<TicketQuery>) =>
    syncQuery({ ...q, ...patch, page: 1 });
  const applyView = (filter: TicketQuery) =>
    syncQuery({ ...filter, page: 1, pageSize: 20 });
  const saveCurrent = () => {
    const name = prompt(t('tickets.savePrompt'));
    if (!name?.trim()) return;
    const { page: _page, pageSize: _size, ...filter } = q;
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
  const statusValue =
    q.scope === 'open'
      ? '__open__'
      : q.scope === 'completed'
        ? '__completed__'
        : (q.status ?? '');
  const setStatus = (value: string) =>
    value === '__open__' || value === '__completed__'
      ? set({
          status: undefined,
          scope: value === '__open__' ? 'open' : 'completed',
        })
      : set({ status: value || undefined, scope: undefined });
  const select = (
    label: string,
    value: string | undefined,
    change: (value: string) => void,
    options: { id: string; name: string }[],
  ) => (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        className={input}
        value={value || ''}
        onChange={(event) => change(event.target.value)}
      >
        <option value="">{t('ticketUi.all')}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
  type Filter = {
    id: string;
    label: string;
    active: boolean;
    clear: () => void;
    control: ReactNode;
  };
  const filters: Filter[] = [
    {
      id: 'number',
      label: t('tickets.colTicketNo'),
      active: !!q.ticketNo,
      clear: () => set({ ticketNo: undefined }),
      control: (
        <input
          className={input}
          aria-label={t('tickets.colTicketNo')}
          placeholder={t('tickets.ticketNoPlaceholder')}
          value={q.ticketNo || ''}
          onChange={(e) => set({ ticketNo: e.target.value || undefined })}
        />
      ),
    },
    {
      id: 'title',
      label: t('tickets.colTitle'),
      active: !!q.keyword,
      clear: () => set({ keyword: undefined }),
      control: (
        <input
          className={input}
          aria-label={t('tickets.colTitle')}
          placeholder={t('tickets.titlePlaceholder')}
          value={q.keyword || ''}
          onChange={(e) => set({ keyword: e.target.value || undefined })}
        />
      ),
    },
    {
      id: 'datacenter',
      label: t('ticketNew.datacenter'),
      active: !!q.datacenterId,
      clear: () => set({ datacenterId: undefined }),
      control: select(
        t('ticketNew.datacenter'),
        q.datacenterId,
        (value) => set({ datacenterId: value || undefined }),
        [
          { id: '__none__', name: t('common.notSpecified') },
          ...(datacenters || []),
        ],
      ),
    },
    {
      id: 'category',
      label: t('tickets.colCategory'),
      active: !!q.categoryId,
      clear: () => set({ categoryId: undefined }),
      control: select(
        t('tickets.colCategory'),
        q.categoryId,
        (value) => set({ categoryId: value || undefined }),
        (categories || []).map((item: { id: string; name: string }) => ({
          ...item,
          name: metadataLabel(t, 'category', item.name),
        })),
      ),
    },
    {
      id: 'queue',
      label: t('ticketNew.queue'),
      active: !!q.queueId,
      clear: () => set({ queueId: undefined }),
      control: select(
        t('ticketNew.queue'),
        q.queueId,
        (value) => set({ queueId: value || undefined }),
        (queues || []).map((item: { id: string; name: string }) => ({
          ...item,
          name: metadataLabel(t, 'queue', item.name),
        })),
      ),
    },
    {
      id: 'status',
      label: t('tickets.colStatus'),
      active: !!q.status || q.scope === 'open' || q.scope === 'completed',
      clear: () => set({ status: undefined, scope: undefined }),
      control: select(t('tickets.colStatus'), statusValue, setStatus, [
        { id: '__open__', name: t('dashboard.open') },
        { id: '__completed__', name: t('dashboard.done') },
        ...STATUS_KEYS.map((id) => ({ id, name: statusLabel(t, id) })),
      ]),
    },
    {
      id: 'sla',
      label: t('tickets.colSla'),
      active: !!q.slaState,
      clear: () => set({ slaState: undefined }),
      control: select(
        t('tickets.colSla'),
        q.slaState,
        (value) =>
          set({ slaState: (value as TicketQuery['slaState']) || undefined }),
        ['overdue', 'within', 'paused', 'completed', 'unset'].map((id) => ({
          id,
          name: t(`ticketUi.${id}`),
        })),
      ),
    },
    {
      id: 'priority',
      label: t('tickets.colPriority'),
      active: !!q.priority,
      clear: () => set({ priority: undefined }),
      control: select(
        t('tickets.colPriority'),
        q.priority,
        (value) => set({ priority: value || undefined }),
        PRIORITY_KEYS.map((id) => ({ id, name: priorityLabel(t, id) })),
      ),
    },
    {
      id: 'assignee',
      label: t('tickets.colAssignee'),
      active: !!q.assigneeId,
      clear: () => set({ assigneeId: undefined }),
      control: select(
        t('tickets.colAssignee'),
        q.assigneeId,
        (value) => set({ assigneeId: value || undefined }),
        [
          { id: '__none__', name: t('ticketDetail.unassigned') },
          ...(filterPeople || []),
        ],
      ),
    },
    {
      id: 'requester',
      label: t('tickets.colRequester'),
      active: !!q.requesterId,
      clear: () => set({ requesterId: undefined }),
      control: select(
        t('tickets.colRequester'),
        q.requesterId,
        (value) => set({ requesterId: value || undefined }),
        filterPeople || [],
      ),
    },
    {
      id: 'created',
      label: t('tickets.colCreatedAt'),
      active: !!q.createdFrom || !!q.createdTo,
      clear: () => set({ createdFrom: undefined, createdTo: undefined }),
      control: (
        <div className="space-y-2">
          {(['createdFrom', 'createdTo'] as const).map((key) => (
            <label key={key} className="block space-y-1">
              <span>
                {t(key === 'createdFrom' ? 'ticketUi.from' : 'ticketUi.to')}
              </span>
              <input
                type="date"
                className={input}
                value={boundaryDate(q[key], key === 'createdTo')}
                onChange={(e) =>
                  set({
                    [key]: dateBoundary(e.target.value, key === 'createdTo'),
                  })
                }
              />
            </label>
          ))}
        </div>
      ),
    },
  ];
  const filter = (field: Filter) => (
    <ColumnFilter
      key={field.id}
      label={field.label}
      active={field.active}
      onClear={field.clear}
    >
      {field.control}
    </ColumnFilter>
  );
  const actions = (ticket: NonNullable<typeof data>['items'][number]) => (
    <>
      <Link
        to={`/tickets/${ticket.id}`}
        className="inline-flex min-h-11 items-center text-sky-600 hover:underline dark:text-sky-400"
      >
        {t('common.view')}
      </Link>
      {(isAdmin || ticket.requester?.id === userId) && (
        <button
          type="button"
          disabled={del.isPending}
          onClick={() => {
            if (confirm(t('tickets.confirmDelete', { no: ticket.ticketNo })))
              del.mutate(ticket.id);
          }}
          className="ml-3 min-h-11 text-red-500 hover:underline disabled:opacity-50"
        >
          {t('common.delete')}
        </button>
      )}
    </>
  );
  return (
    <div className="space-y-4">
      <Toast show={copied} message={t('tickets.copied')} />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('tickets.title')}</h1>
        {has('ticket:create') && (
          <Link
            to="/tickets/new"
            className="rounded-md bg-brand-700 px-4 py-2 text-sm text-white hover:bg-brand-800"
          >
            {t('tickets.new')}
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => applyView({})}
          className="min-h-9 rounded-full border border-gray-300 px-3 text-xs dark:border-gray-700"
        >
          {t('tickets.filterAll')}
        </button>
        {scopeLabel && (
          <button
            onClick={() => set({ scope: undefined })}
            className="min-h-9 rounded-full border border-brand-200 bg-brand-50 px-3 text-xs text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"
          >
            {scopeLabel} ×
          </button>
        )}
        {views?.map((view) => (
          <span
            key={view.id}
            className="inline-flex items-center rounded-full border border-brand-200 bg-brand-50 px-3 text-xs text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"
          >
            <button
              className="min-h-9"
              onClick={() => applyView(view.filterJson)}
            >
              {view.name}
            </button>
            <button
              onClick={() => delView.mutate(view.id)}
              aria-label={t('tickets.deleteView')}
              className="ml-2 min-h-9 min-w-6 hover:text-red-500"
            >
              ×
            </button>
          </span>
        ))}
        <button
          onClick={saveCurrent}
          className="min-h-9 rounded-full border border-dashed border-gray-300 px-3 text-xs text-gray-500 dark:border-gray-700"
        >
          {t('tickets.saveView')}
        </button>
      </div>
      <details className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900 lg:hidden">
        <summary className="cursor-pointer text-sm">
          {t('ticketUi.filters')} (
          {filters.filter((field) => field.active).length})
        </summary>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {filters.map(filter)}
        </div>
      </details>
      {isError && (
        <p role="alert" className="text-sm text-red-600">
          {t('ticketUi.loadFailed')}{' '}
          <button className="min-h-11 underline" onClick={() => void refetch()}>
            {t('ticketAttributes.retry')}
          </button>
        </p>
      )}
      {del.isError && (
        <p role="alert" className="text-sm text-red-600">
          {t('ticketUi.failed')}
        </p>
      )}
      <div className="space-y-3 lg:hidden">
        {isLoading && (
          <p className="py-8 text-center text-gray-400">
            {t('common.loading')}
          </p>
        )}
        {data?.items.map((ticket) => (
          <article
            key={ticket.id}
            className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
          >
            <Link
              to={`/tickets/${ticket.id}`}
              className="block font-medium text-sky-600 dark:text-sky-400"
            >
              {ticket.title}
            </Link>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {t('ticketNew.datacenter')}:{' '}
              {ticket.datacenter?.name || t('common.notSpecified')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <button
                onClick={() => copy(ticket.ticketNo)}
                title={t('tickets.copyTicketNo')}
                className="min-h-9 font-mono"
              >
                {ticket.ticketNo}
              </button>
              <span
                className={`rounded px-2 py-0.5 ${STATUS_COLOR[ticket.status]}`}
              >
                {statusLabel(t, ticket.status)}
              </span>
              <span className={PRIORITY_COLOR[ticket.priority]}>
                {priorityLabel(t, ticket.priority)}
              </span>
              <SlaBadge slaDueAt={ticket.slaDueAt} status={ticket.status} />
              {ticket.category && (
                <span>
                  {metadataLabel(t, 'category', ticket.category.name)}
                </span>
              )}
              <span>{fmt.compact(ticket.createdAt)}</span>
            </div>
            <div className="mt-2 flex items-center border-t border-gray-100 pt-1 text-xs dark:border-gray-800">
              <span className="mr-auto text-gray-400">
                {ticket.assignee?.name || t('ticketDetail.unassigned')}
              </span>
              {actions(ticket)}
            </div>
          </article>
        ))}
        {data?.items.length === 0 && (
          <p className="py-8 text-center text-gray-400">{t('tickets.empty')}</p>
        )}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 lg:block">
        <table className="w-full min-w-[88rem] text-sm">
          <thead className="bg-gray-50 text-gray-500 dark:bg-gray-800">
            <tr>
              {filters.map((field) => (
                <th
                  key={field.id}
                  scope="col"
                  className={`px-3 py-1 text-left font-medium ${field.id === 'title' ? 'min-w-56' : ''}`}
                >
                  {filter(field)}
                </th>
              ))}
              <th
                scope="col"
                className="whitespace-nowrap px-4 py-2 text-right font-medium"
              >
                {t('common.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td
                  colSpan={12}
                  className="px-4 py-8 text-center text-gray-400"
                >
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {data?.items.map((ticket) => (
              <tr
                key={ticket.id}
                className="border-t border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50"
              >
                <td
                  className="sla-rail whitespace-nowrap px-3 py-2"
                  style={
                    {
                      '--rail': slaRailColor(ticket.slaDueAt, ticket.status),
                    } as React.CSSProperties
                  }
                >
                  <button
                    onClick={() => copy(ticket.ticketNo)}
                    aria-label={t('tickets.copyTicketNo')}
                    title={t('tickets.copyTicketNo')}
                    className="min-h-11 font-mono text-xs text-gray-500 dark:text-gray-400"
                  >
                    {ticket.ticketNo}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <Link
                    to={`/tickets/${ticket.id}`}
                    className="font-medium text-sky-600 hover:underline dark:text-sky-400"
                  >
                    {ticket.title}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {ticket.datacenter?.name || t('common.notSpecified')}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {ticket.category
                    ? metadataLabel(t, 'category', ticket.category.name)
                    : t('common.empty')}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {ticket.queue
                    ? metadataLabel(t, 'queue', ticket.queue.name)
                    : t('common.empty')}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[ticket.status]}`}
                  >
                    {statusLabel(t, ticket.status)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <SlaBadge slaDueAt={ticket.slaDueAt} status={ticket.status} />
                </td>
                <td
                  className={`whitespace-nowrap px-3 py-2 ${PRIORITY_COLOR[ticket.priority]}`}
                >
                  {priorityLabel(t, ticket.priority)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {ticket.assignee?.name || t('common.empty')}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {ticket.requester?.name}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-400">
                  {fmt.compact(ticket.createdAt)}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right text-xs">
                  {actions(ticket)}
                </td>
              </tr>
            ))}
            {data?.items.length === 0 && (
              <tr>
                <td
                  colSpan={12}
                  className="px-4 py-8 text-center text-gray-400"
                >
                  {t('tickets.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3 text-sm">
          <span className="text-gray-400">
            {t('tickets.pagination', {
              total: data.total,
              page: q.page || 1,
              pages: totalPages,
            })}
          </span>
          <button
            disabled={(q.page || 1) <= 1}
            onClick={() => syncQuery({ ...q, page: (q.page || 1) - 1 })}
            className="min-h-11 rounded border border-gray-300 px-3 disabled:opacity-40 dark:border-gray-700"
          >
            {t('tickets.prev')}
          </button>
          <button
            disabled={(q.page || 1) >= totalPages}
            onClick={() => syncQuery({ ...q, page: (q.page || 1) + 1 })}
            className="min-h-11 rounded border border-gray-300 px-3 disabled:opacity-40 dark:border-gray-700"
          >
            {t('tickets.next')}
          </button>
        </div>
      )}
    </div>
  );
}
