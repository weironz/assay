import { Link } from 'react-router-dom';
import { useOverview } from '../features/stats/api';
import { useAuth } from '../stores/auth';
import { STATUS_LABEL, STATUS_COLOR } from '../lib/ticket-meta';

function StatCard({
  label,
  value,
  tone = 'default',
  to,
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warn' | 'danger' | 'primary';
  to?: string;
}) {
  const toneCls = {
    default: 'text-gray-900 dark:text-gray-100',
    primary: 'text-blue-600',
    warn: 'text-amber-600',
    danger: 'text-red-600',
  }[tone];
  const body = (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 hover:shadow-sm transition">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`text-3xl font-semibold mt-1 ${toneCls}`}>{value}</div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export default function DashboardPage() {
  const user = useAuth((s) => s.user);
  const { data, isLoading } = useOverview();

  const openStatuses = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'REOPENED'];
  const maxCount = data
    ? Math.max(1, ...openStatuses.map((s) => data.byStatus[s] ?? 0))
    : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">仪表盘</h1>
        <p className="text-sm text-gray-400 mt-1">
          欢迎，{user?.name}（{user?.roles.join(', ')}）
        </p>
      </div>

      {isLoading || !data ? (
        <div className="text-gray-400">加载中…</div>
      ) : (
        <>
          {/* 指标卡 */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="工单总数" value={data.total} to="/tickets" />
            <StatCard label="进行中" value={data.open} tone="primary" to="/tickets" />
            <StatCard label="我的待办" value={data.myTodo} tone="primary" to="/tickets" />
            <StatCard label="未分派" value={data.unassigned} tone="warn" to="/tickets" />
            <StatCard label="已超时" value={data.overdue} tone="danger" to="/tickets" />
            <StatCard label="未读通知" value={data.unread} />
          </div>

          {/* 状态分布 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <h2 className="text-sm font-medium text-gray-500 mb-4">进行中工单状态分布</h2>
            <div className="space-y-2">
              {openStatuses.map((s) => {
                const n = data.byStatus[s] ?? 0;
                return (
                  <div key={s} className="flex items-center gap-3">
                    <span
                      className={`w-20 text-xs px-2 py-0.5 rounded text-center ${STATUS_COLOR[s]}`}
                    >
                      {STATUS_LABEL[s]}
                    </span>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-5 overflow-hidden">
                      <div
                        className="h-full bg-blue-500/70 rounded flex items-center justify-end pr-2"
                        style={{ width: `${(n / maxCount) * 100}%`, minWidth: n ? 24 : 0 }}
                      >
                        {n > 0 && <span className="text-[10px] text-white">{n}</span>}
                      </div>
                    </div>
                    <span className="w-8 text-right text-sm text-gray-500">{n}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
