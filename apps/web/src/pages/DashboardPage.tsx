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
  // 零值不着色：颜色只用来标记「有事要处理」，0 个待办不是需要注意的事
  const toneCls =
    value === 0
      ? 'text-gray-300 dark:text-gray-600'
      : {
          default: 'text-gray-900 dark:text-gray-100',
          primary: 'text-brand-700 dark:text-brand-400',
          warn: 'text-amber-600',
          danger: 'text-red-600',
        }[tone];
  const body = (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 transition hover:border-brand-300 dark:hover:border-brand-800">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${toneCls}`}>
        {value}
      </div>
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
                      className={`w-20 whitespace-nowrap rounded px-2 py-0.5 text-center text-xs ${STATUS_COLOR[s]}`}
                    >
                      {STATUS_LABEL[s]}
                    </span>
                    {/* 常态分布不该用饱和色喊人：条形压成淡品牌绿，读数交给右侧数字 */}
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                      <div
                        className="h-full rounded-full bg-brand-300 transition-[width] duration-500 dark:bg-brand-800"
                        style={{ width: `${(n / maxCount) * 100}%` }}
                      />
                    </div>
                    <span
                      className={`w-8 text-right text-sm tabular-nums ${
                        n === 0
                          ? 'text-gray-300 dark:text-gray-600'
                          : 'text-gray-700 dark:text-gray-200'
                      }`}
                    >
                      {n}
                    </span>
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
