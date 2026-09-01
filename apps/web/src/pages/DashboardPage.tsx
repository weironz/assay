import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useOverview } from '../features/stats/api';
import { useAuth } from '../stores/auth';
import { statusLabel, STATUS_COLOR } from '../lib/ticket-meta';

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

/** 一组状态的条形分布，按组内最大值缩放 */
function StatusBars({
  caption,
  statuses,
  byStatus,
  className = '',
}: {
  caption: string;
  statuses: string[];
  byStatus: Record<string, number>;
  className?: string;
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...statuses.map((s) => byStatus[s] ?? 0));
  return (
    <div className={className}>
      <p className="mb-2 text-xs text-gray-400">{caption}</p>
      <div className="space-y-2">
        {statuses.map((s) => {
          const n = byStatus[s] ?? 0;
          return (
            <div key={s} className="flex items-center gap-3">
              {/* 固定宽度让右侧进度条对齐；标签长度随语言变化，超出则截断 */}
              <span
                className={`w-28 shrink-0 truncate rounded px-2 py-0.5 text-center text-xs ${STATUS_COLOR[s]}`}
                title={statusLabel(t, s)}
              >
                {statusLabel(t, s)}
              </span>
              {/* 常态分布不该用饱和色喊人：条形压成淡品牌绿，读数交给右侧数字 */}
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                <div
                  className="h-full rounded-full bg-brand-300 transition-[width] duration-500 dark:bg-brand-800"
                  style={{ width: `${(n / max) * 100}%` }}
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
  );
}

/** 还在流程里的状态 */
const OPEN_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'REOPENED'];
/** 办成了的终态 */
const DONE_STATUSES = ['RESOLVED', 'CLOSED'];
/** 终态里的作废，单独列，不算进「已完成」 */
const CLOSED_STATUSES = [...DONE_STATUSES, 'CANCELLED'];

export default function DashboardPage() {
  const { t } = useTranslation();
  const user = useAuth((s) => s.user);
  const { data, isLoading } = useOverview();

  const byStatus = data?.byStatus ?? {};
  const sum = (list: string[]) =>
    list.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
  // 「已完成」不含已取消：取消是作废，不是把事办成了，混在一起会虚高
  const done = sum(DONE_STATUSES);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('dashboard.title')}</h1>
        <p className="text-sm text-gray-400 mt-1">
          {t('dashboard.welcome', {
            name: user?.name ?? '',
            roles: user?.roles.join(', ') ?? '',
          })}
        </p>
      </div>

      {isLoading || !data ? (
        <div className="text-gray-400">{t('common.loading')}</div>
      ) : (
        <>
          {/* 指标卡 */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard label={t('dashboard.total')} value={data.total} to="/tickets" />
            <StatCard label={t('dashboard.open')} value={data.open} tone="primary" to="/tickets" />
            <StatCard label={t('dashboard.done')} value={done} to="/tickets" />
            <StatCard label={t('dashboard.myTodo')} value={data.myTodo} tone="primary" to="/tickets" />
            <StatCard label={t('dashboard.unassigned')} value={data.unassigned} tone="warn" to="/tickets" />
            <StatCard label={t('dashboard.overdue')} value={data.overdue} tone="danger" to="/tickets" />
            <StatCard label={t('dashboard.unread')} value={data.unread} />
          </div>

          {/* 状态分布 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <h2 className="text-sm font-medium text-gray-500 mb-4">
              {t('dashboard.distribution')}
            </h2>
            {/* 分两组、各自按组内最大值缩放。合在一起用同一把尺子的话，
                已关闭往往远多于在办工单，会把在办那几根压成看不见的细线 */}
            <StatusBars
              caption={t('dashboard.groupOpen')}
              statuses={OPEN_STATUSES}
              byStatus={byStatus}
            />
            <StatusBars
              caption={t('dashboard.groupClosed')}
              statuses={CLOSED_STATUSES}
              byStatus={byStatus}
              className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-800"
            />
          </div>
        </>
      )}
    </div>
  );
}
