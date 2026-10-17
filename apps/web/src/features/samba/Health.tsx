import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  DataTable,
  Info,
  button,
  card,
  input,
  link,
} from './components';
import {
  filetimeDays,
  filetimeMinutes,
  formatTime,
  type Employee,
  type Workspace,
} from './types';

const DAY = 86_400_000;
const STALE_DAYS = 90;
const EXPIRING_DAYS = 30;

type Concern = 'locked' | 'expiring' | 'expired' | 'never' | 'stale' | 'disabled';

const CONCERN_LABELS: Record<Concern, string> = {
  locked: '已锁定',
  expiring: '密码即将过期',
  expired: '密码已过期',
  never: '从未登录',
  stale: '长期未登录',
  disabled: '已停用',
};

function concernsOf(u: Employee, now: number): Concern[] {
  const out: Concern[] = [];
  if (u.disabled) out.push('disabled');
  if (u.locked) out.push('locked');
  if (u.passwordExpiresAt) {
    if (u.passwordExpiresAt <= now) out.push('expired');
    else if (u.passwordExpiresAt <= now + EXPIRING_DAYS * DAY) out.push('expiring');
  }
  if (!u.lastLogonAt) out.push('never');
  else if (u.lastLogonAt < now - STALE_DAYS * DAY) out.push('stale');
  return out;
}

export function Health({ snapshot, canWrite, confirm }: Workspace) {
  const [filter, setFilter] = useState<Concern | 'all'>('all');
  const [exporting, setExporting] = useState(false);
  const now = Date.now();
  const users = useMemo(
    () =>
      snapshot.users.map((u) => ({ user: u, concerns: concernsOf(u, now) })),
    [snapshot.users, now],
  );
  const rows = users.filter(
    ({ concerns }) => filter === 'all' || concerns.includes(filter),
  );
  const counts = useMemo(() => {
    const map = { locked: 0, expiring: 0, expired: 0, never: 0, stale: 0, disabled: 0 } as Record<Concern, number>;
    for (const { concerns } of users)
      for (const c of concerns) map[c]++;
    return map;
  }, [users]);
  const policy = snapshot.policy;

  async function exportCsv() {
    setExporting(true);
    try {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('账号健康');
      sheet.addRow(['登录账号', '员工姓名', '部门', '状态', '失败次数', '最近登录', '密码到期']);
      for (const { user: u, concerns } of users)
        sheet.addRow([
          u.name,
          u.displayName,
          u.department,
          concerns.map((c) => CONCERN_LABELS[c]).join('、') || '正常',
          u.badPasswords ?? 0,
          u.lastLogonAt ? formatTime(u.lastLogonAt) : '从未登录',
          u.passwordExpiresAt ? formatTime(u.passwordExpiresAt) : '无过期策略',
        ]);
      const buffer = await workbook.csv.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `account-health-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const [editDays, setEditDays] = useState('');
  const [editThreshold, setEditThreshold] = useState('');
  const [editLockMinutes, setEditLockMinutes] = useState('');
  const [policyError, setPolicyError] = useState('');
  const saveMaxAge = () => {
    const raw = editDays.trim();
    if (raw === '') return;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      setPolicyError('密码有效期需为 0–3650 的整数天数（0 = 永不过期）');
      return;
    }
    setPolicyError('');
    confirm(
      days === 0 ? '设置域密码永不过期' : `设置域密码有效期为 ${days} 天`,
      'policy.set',
      { max_pwd_age_days: days },
      undefined,
      [
        ['变更项', '域密码有效期（maxPwdAge）'],
        ['新值', days === 0 ? '永不过期' : `${days} 天`],
        ['影响', days === 0 ? '全员密码不再因过期被要求修改' : `密码超过 ${days} 天未改将被要求修改`],
      ],
    );
  };
  const saveLockout = () => {
    const rawT = editThreshold.trim();
    const rawM = editLockMinutes.trim();
    if (rawT === '' && rawM === '') return;
    const threshold = rawT === '' ? null : Number(rawT);
    const minutes = rawM === '' ? null : Number(rawM);
    if (threshold !== null && (!Number.isInteger(threshold) || threshold < 0 || threshold > 1000)) {
      setPolicyError('锁定阈值需为 0–1000 的整数（0 = 不再自动锁定）');
      return;
    }
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 43200)) {
      setPolicyError('锁定时长需为 0–43200 的整数分钟（0 = 锁定后需管理员解锁）');
      return;
    }
    setPolicyError('');
    const args: Record<string, number> = {};
    const preview: [string, string][] = [];
    if (threshold !== null) {
      args.lockout_threshold = threshold;
      preview.push(['锁定阈值', threshold === 0 ? '不自动锁定' : `连续 ${threshold} 次失败`]);
    }
    if (minutes !== null) {
      args.lockout_duration_minutes = minutes;
      preview.push(['锁定时长', minutes === 0 ? '永久（需手动解锁）' : `${minutes} 分钟后自动解锁`]);
    }
    confirm('修改域账号锁定策略', 'policy.set', args, undefined, preview);
  };

  return (
    <div className="space-y-6">
      <section className={card + ' p-6'}>
        <h2 className="mb-5 font-semibold">域密码与锁定策略</h2>
        <dl className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <Info label="最短密码长度">
            {policy?.minPwdLength ? `${Number(policy.minPwdLength)} 个字符` : '未配置'}
          </Info>
          <div className="min-w-0">
            <dt className="text-sm text-gray-500">密码有效期</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm font-medium">
              <span>
                {filetimeDays(policy?.maxPwdAge) !== null
                  ? `${filetimeDays(policy?.maxPwdAge)} 天`
                  : '永不过期'}
              </span>
              {canWrite && (
                <>
                  <input
                    className="min-h-8 w-20 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                    type="number"
                    min={0}
                    max={3650}
                    placeholder="天数"
                    aria-label="新的密码有效天数（0 为永不过期）"
                    value={editDays}
                    onChange={(e) => setEditDays(e.target.value)}
                  />
                  <button className={button + ' min-h-8 px-2 py-1'} onClick={saveMaxAge}>
                    修改
                  </button>
                </>
              )}
            </dd>
            {policyError && (
              <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
                {policyError}
              </p>
            )}
          </div>
          <Info label="密码历史数量">
            {policy?.pwdHistoryLength ? Number(policy.pwdHistoryLength) : '未配置'}
          </Info>
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-sm text-gray-500">账号锁定</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm font-medium">
              <span>
                {Number(policy?.lockoutThreshold) > 0
                  ? `连续 ${Number(policy?.lockoutThreshold)} 次失败锁定`
                  : '失败不自动锁定'}
                {Number(policy?.lockoutThreshold) > 0 && filetimeMinutes(policy?.lockoutDuration) !== null
                  ? `，${filetimeMinutes(policy?.lockoutDuration)} 分钟后自动解锁`
                  : Number(policy?.lockoutThreshold) > 0
                    ? '，永久（需手动解锁）'
                    : ''}
              </span>
              {canWrite && (
                <>
                  <input
                    className="min-h-8 w-20 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                    type="number"
                    min={0}
                    max={1000}
                    placeholder="次数"
                    aria-label="新的锁定阈值（0 为不自动锁定）"
                    value={editThreshold}
                    onChange={(e) => setEditThreshold(e.target.value)}
                  />
                  <input
                    className="min-h-8 w-24 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                    type="number"
                    min={0}
                    max={43200}
                    placeholder="分钟"
                    aria-label="新的锁定时长分钟（0 为需手动解锁）"
                    value={editLockMinutes}
                    onChange={(e) => setEditLockMinutes(e.target.value)}
                  />
                  <button className={button + ' min-h-8 px-2 py-1'} onClick={saveLockout}>
                    修改
                  </button>
                </>
              )}
            </dd>
            {policyError && (
              <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
                {policyError}
              </p>
            )}
          </div>
          <Info label="锁定观察窗口">
            {filetimeDays(policy?.lockoutObservationWindow) !== null
              ? `${filetimeMinutes(policy?.lockoutObservationWindow)} 分钟`
              : '未配置'}
          </Info>
        </dl>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">账号健康总览</h2>
          <button className={button} disabled={exporting} onClick={() => void exportCsv()}>
            {exporting ? '正在导出…' : '导出 CSV'}
          </button>
        </div>
        <DataTable
          label="账号健康"
          rows={rows}
          rowKey={({ user }) => user.id}
          searchText={({ user, concerns }) =>
            `${user.name} ${user.displayName} ${user.department} ${concerns.map((c) => CONCERN_LABELS[c]).join(' ')}`
          }
          empty="没有符合当前筛选的账号"
          filters={
            <select
              className={input + ' sm:w-auto'}
              aria-label="健康筛选"
              value={filter}
              onChange={(e) => setFilter(e.target.value as Concern | 'all')}
            >
              <option value="all">全部账号（{users.length}）</option>
              {(Object.keys(CONCERN_LABELS) as Concern[]).map((c) => (
                <option key={c} value={c}>
                  {CONCERN_LABELS[c]}（{counts[c]}）
                </option>
              ))}
            </select>
          }
          columns={[
            {
              label: '员工',
              render: ({ user }) => (
                <div>
                  <Link to={`/samba/users/${user.id}`} className={link}>
                    {user.displayName || user.name}
                  </Link>
                  <p className="mt-1 text-xs text-gray-500">{user.name}</p>
                </div>
              ),
            },
            { label: '部门', render: ({ user }) => user.department || '—' },
            {
              label: '健康关注',
              render: ({ concerns }) => (
                <span className="flex flex-wrap gap-1">
                  {concerns.length ? (
                    concerns.map((c) => (
                      <Badge key={c} danger={c === 'locked' || c === 'expired'} muted={c === 'disabled'}>
                        {CONCERN_LABELS[c]}
                      </Badge>
                    ))
                  ) : (
                    <Badge>正常</Badge>
                  )}
                </span>
              ),
            },
            {
              label: '失败次数',
              render: ({ user }) => (user.badPasswords ? `${user.badPasswords}` : '—'),
            },
            {
              label: '最近登录',
              render: ({ user }) => formatTime(user.lastLogonAt),
            },
            {
              label: '密码到期',
              render: ({ user }) => formatTime(user.passwordExpiresAt),
            },
            {
              label: '操作',
              render: ({ user }) =>
                user.locked && canWrite && user.manageable !== false ? (
                  <button
                    className={button}
                    onClick={() =>
                      confirm(`解锁账号 ${user.name}`, 'user.unlock', { id: user.id })
                    }
                  >
                    解锁
                  </button>
                ) : (
                  <Link className={link} to={`/samba/users/${user.id}`}>
                    详情 →
                  </Link>
                ),
            },
          ]}
        />
      </section>
    </div>
  );
}
