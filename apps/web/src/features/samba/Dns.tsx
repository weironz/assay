import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Badge, DataTable, button, card, input } from './components';

function failed(e: unknown) {
  return (e as { response?: { data?: { message?: string } } })?.response?.data
    ?.message || '加载失败';
}

type DnsRecord = { name: string; type: string; data: string; ttl: number; dynamic: boolean };

export function Dns() {
  const [zones, setZones] = useState<string[]>([]);
  const [zone, setZone] = useState('');
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get('/samba/dns')
      .then((r) => setZones(r.data.zones || []))
      .catch((e) => setError(failed(e)));
  }, []);

  useEffect(() => {
    if (!zone) return;
    setBusy(true);
    setError('');
    void api
      .get('/samba/dns', { params: { zone } })
      .then((r) => setRecords(r.data.records || []))
      .catch((e) => setError(failed(e)))
      .finally(() => setBusy(false));
  }, [zone]);

  return (
    <div className="space-y-6">
      <section className={card + ' flex flex-wrap items-center gap-3 p-5'}>
        <select
          className={input + ' sm:w-80'}
          aria-label="选择 DNS 区域"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
        >
          <option value="">选择要查看的 DNS 区域…</option>
          {zones.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
        {busy && <span className="text-sm text-gray-500">加载中…</span>}
        <span className="text-xs text-gray-500">
          只读视图：区域与记录由 AD DNS 动态数据构成，修改请使用 samba-tool 或 RSAT。
        </span>
      </section>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </p>
      )}
      {zone && (
        <DataTable
          label={`DNS 记录 · ${zone}`}
          rows={records}
          rowKey={(r) => r.name + r.type + r.data}
          searchText={(r) => `${r.name} ${r.type} ${r.data}`}
          empty="该区域没有记录"
          columns={[
            { label: '名称', render: (r) => r.name },
            { label: '类型', render: (r) => <Badge muted>{r.type}</Badge> },
            { label: '数据', render: (r) => <span className="break-all">{r.data}</span> },
            { label: 'TTL（秒）', render: (r) => r.ttl.toLocaleString() },
            {
              label: '来源',
              render: (r) => (r.dynamic ? '动态注册' : '静态'),
            },
          ]}
        />
      )}
    </div>
  );
}

type SmbStatus = {
  sessions?: unknown;
  tcons?: unknown;
  shares?: unknown;
  open_files?: unknown;
  locks?: unknown;
};

/**
 * smbstatus --json 的 sessions/tcons/open_files 是以 ID 为键的对象而非数组
 * （空时为 {}），归一化为行数组：每项值若是对象则展开并带上键作为 id。
 */
function asRows(value: unknown): Record<string, string | number>[] {
  if (Array.isArray(value)) return value as Record<string, string | number>[];
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).map(([key, v]) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? ({ id: key, ...(v as object) } as Record<string, string | number>)
        : { id: key, value: String(v) },
    );
  return [];
}

function GenericTable({
  label,
  rows,
}: {
  label: string;
  rows: Record<string, string | number>[];
}) {
  const indexed = rows.map(
    (r, i): Record<string, string | number> => ({ ...r, __i: i }),
  );
  const columns = Object.keys(indexed[0] || {}).filter((k) => k !== "__i");
  return (
    <DataTable
      label={label}
      rows={indexed}
      rowKey={(r) => String(r.__i)}
      searchText={(r) => columns.map((c) => r[c]).join(' ')}
      empty="暂无记录"
      columns={columns.map((c) => ({
        label: c,
        render: (r: (typeof indexed)[number]) => (
          <span className="break-all">{String(r[c] ?? '—')}</span>
        ),
      }))}
    />
  );
}

export function Sessions() {
  const [data, setData] = useState<SmbStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true);
    setError('');
    void api
      .get('/samba/sessions')
      .then((r) => setData(r.data))
      .catch((e) => setError(failed(e)))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          来自文件服务器 smbstatus 的实时只读快照：当前 SMB 会话、连接与打开的文件。
          在删除共享或重命名对象前可先查看影响面。
        </p>
        <button className={button} disabled={busy} onClick={load}>
          刷新
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
          {error}
          <span className="mt-1 block text-xs">
            若提示未配置，需在 agent.json 中配置 smb_status 并为 Agent 挂载 Samba 状态目录后重启。
          </span>
        </p>
      )}
      {data && (
        <>
          <section className="space-y-3">
            <h2 className="font-semibold">SMB 会话</h2>
            <GenericTable label="SMB 会话" rows={asRows(data.sessions)} />
          </section>
          <section className="space-y-3">
            <h2 className="font-semibold">共享连接</h2>
            <GenericTable label="共享连接" rows={asRows(data.tcons ?? data.shares)} />
          </section>
          <section className="space-y-3">
            <h2 className="font-semibold">打开的文件</h2>
            <GenericTable label="打开的文件" rows={asRows(data.open_files ?? data.locks)} />
          </section>
        </>
      )}
    </div>
  );
}
