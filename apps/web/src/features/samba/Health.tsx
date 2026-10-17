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

  return (
    <div className="space-y-6">
      <section className={card + ' p-6'}>
        <h2 className="mb-5 font-semibold">域密码与锁定策略</h2>
        <dl className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <Info label="最短密码长度">
            {policy?.minPwdLength ? `${Number(policy.minPwdLength)} 个字符` : '未配置'}
          </Info>
          <Info label="密码有效期">
            {filetimeDays(policy?.maxPwdAge) !== null
              ? `${filetimeDays(policy?.maxPwdAge)} 天`
              : '永不过期'}
          </Info>
          <Info label="密码历史数量">
            {policy?.pwdHistoryLength ? Number(policy.pwdHistoryLength) : '未配置'}
          </Info>
          <Info label="锁定阈值">
            {policy?.lockoutThreshold ? `${Number(policy.lockoutThreshold)} 次失败` : '不锁定'}
          </Info>
          <Info label="锁定时长">
            {filetimeDays(policy?.lockoutDuration) !== null
              ? `${filetimeDays(policy!.lockoutDuration)} 天`
              : '永久（需手动解锁）'}
          </Info>
          <Info label="锁定观察窗口">
            {filetimeDays(policy?.lockoutObservationWindow) !== null
              ? `${filetimeDays(policy!.lockoutObservationWindow)} 天`
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
