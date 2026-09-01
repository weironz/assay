import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  STATUS_LABEL,
  STATUS_COLOR,
  PRIORITY_LABEL,
  PRIORITY_COLOR,
  slaRailColor,
} from '../lib/ticket-meta';
import { useAuth } from '../stores/auth';
import SlaBadge from '../components/SlaBadge';

export default function TicketsPage() {
  const has = useAuth((s) => s.has);
  const isAdmin = useAuth((s) => s.hasRole('admin'));
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
    const name = prompt('保存当前筛选为视图，输入名称：');
    if (!name?.trim()) return;
    const { page: _p, pageSize: _s, ...filter } = q;
    saveView.mutate({ name: name.trim(), filter });
  };

  const totalPages = data ? Math.ceil(data.total / (q.pageSize ?? 20)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">工单</h1>
        {has('ticket:create') && (
          <Link
            to="/tickets/new"
            className="rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800"
          >
            + 新建工单
          </Link>
        )}
      </div>

      {/* 保存的筛选视图 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => applyView({})}
          className="text-xs px-3 py-1 rounded-full border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          全部
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
              title="删除视图"
            >
              ×
            </button>
          </span>
        ))}
        <button
          onClick={saveCurrent}
          className="text-xs px-3 py-1 rounded-full border border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          ★ 保存当前筛选
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3">
        <input
          placeholder="搜索标题 / 工单号"
          value={q.keyword ?? ''}
          onChange={(e) => set({ keyword: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        />
        <select
          value={q.status ?? ''}
          onChange={(e) => set({ status: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        >
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={q.priority ?? ''}
          onChange={(e) => set({ priority: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        >
          <option value="">全部优先级</option>
          {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={q.queueId ?? ''}
          onChange={(e) => set({ queueId: e.target.value || undefined })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
        >
          <option value="">全部队列</option>
          {queues?.map((qu: any) => (
            <option key={qu.id} value={qu.id}>
              {qu.name}
            </option>
          ))}
        </select>
      </div>

      {/* 列表 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
            <tr>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">工单号</th>
              <th className="w-full px-4 py-2 text-left font-medium">标题</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">状态</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">SLA</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">优先级</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">处理人</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">提单人</th>
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">创建时间</th>
              {isAdmin && <th className="whitespace-nowrap px-4 py-2 text-right font-medium">操作</th>}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={isAdmin ? 9 : 8} className="px-4 py-8 text-center text-gray-400">
                  加载中…
                </td>
              </tr>
            )}
            {data?.items.map((t) => (
              <tr
                key={t.id}
                className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
              >
                <td
                  className="sla-rail whitespace-nowrap py-2 pl-4 pr-3"
                  style={
                    {
                      '--rail': slaRailColor(t.slaDueAt, t.status),
                    } as React.CSSProperties
                  }
                >
                  <Link
                    to={`/tickets/${t.id}`}
                    className="font-mono text-xs text-gray-500 hover:text-brand-700 dark:text-gray-400"
                  >
                    {t.ticketNo}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <Link
                    to={`/tickets/${t.id}`}
                    className="font-medium text-gray-800 hover:text-brand-700 dark:text-gray-100 dark:hover:text-brand-400"
                  >
                    {t.title}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <span
                    className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs ${STATUS_COLOR[t.status]}`}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <SlaBadge slaDueAt={t.slaDueAt} status={t.status} />
                </td>
                <td className={`whitespace-nowrap px-4 py-2 text-sm ${PRIORITY_COLOR[t.priority]}`}>
                  {PRIORITY_LABEL[t.priority]}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-600 dark:text-gray-300">
                  {t.assignee?.name ?? '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-gray-600 dark:text-gray-300">
                  {t.requester?.name}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-400">
                  {new Date(t.createdAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                {isAdmin && (
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <button
                      onClick={() => {
                        if (confirm(`确认删除工单 ${t.ticketNo}？`)) del.mutate(t.id);
                      }}
                      className="text-red-500 text-xs hover:underline"
                    >
                      删除
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 9 : 8} className="px-4 py-8 text-center text-gray-400">
                  暂无工单
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
            共 {data.total} 条 · 第 {q.page}/{totalPages} 页
          </span>
          <button
            disabled={(q.page ?? 1) <= 1}
            onClick={() => setQ((p) => ({ ...p, page: (p.page ?? 1) - 1 }))}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40"
          >
            上一页
          </button>
          <button
            disabled={(q.page ?? 1) >= totalPages}
            onClick={() => setQ((p) => ({ ...p, page: (p.page ?? 1) + 1 }))}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-700 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
