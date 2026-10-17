import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import {
  Badge,
  DataTable,
  button,
  card,
  input,
  link,
  primary,
} from './components';
import {
  type Employee,
  type Workspace,
} from './types';
import {
  employeeTemplateCsv,
  readEmployeeImportFile,
  type EmployeeImportRow,
} from './import';

const RESERVED = ['administrator', 'krbtgt', 'guest', 'domain_admins', 'sysvol', 'netlogon'];
const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,47}$/;

export type BulkResult = {
  total: number;
  created: number;
  results: {
    row: string;
    operationId: string;
    state: string;
    ok: boolean;
    error?: string;
  }[];
};

type Row = EmployeeImportRow & { problem?: string };

function validate(rows: EmployeeImportRow[], users: Employee[]): Row[] {
  const existing = new Set(users.map((u) => u.name.toLowerCase()));
  const seen = new Set<string>();
  return rows.map((r) => {
    let problem = '';
    if (!NAME_PATTERN.test(r.name))
      problem = '登录账号需 2–48 位，小写字母开头，仅含小写字母/数字/下划线/短横线';
    else if (RESERVED.includes(r.name)) problem = '系统保留名称';
    else if (seen.has(r.name)) problem = '文件内登录账号重复';
    else if (!r.display_name) problem = '缺少员工姓名';
    else if (r.password.length < 8 || r.password.length > 512 || r.password.includes('\0'))
      problem = '初始密码需 8–512 个字符';
    else if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) problem = '邮箱格式无效';
    else if (existing.has(r.name.toLowerCase())) problem = 'AD 中已存在同名账号';
    seen.add(r.name.toLowerCase());
    return { ...r, problem };
  });
}

export function ImportUsers({
  snapshot,
  canWrite,
  bulk,
  result,
}: Workspace & { bulk: (rows: EmployeeImportRow[]) => void; result: BulkResult | null }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [live, setLive] = useState<BulkResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const outcome = live ?? result;
  const pendingRows = outcome?.results.filter((r) => ['queued', 'running', 'pending'].includes(r.state)) ?? [];

  // 提交后自动轮询每行的操作状态，直到全部出队
  useEffect(() => {
    if (!pendingRows.length || !outcome) return;
    const ids = outcome.results.map((r) => r.operationId);
    const timer = setInterval(() => {
      void Promise.all(
        ids.map((id) => api.get(`/samba/operations/${id}`).then((r) => r.data).catch(() => null)),
      ).then((ops) => {
        if (!ops.length) return;
        setLive((current) => {
          const base = current ?? outcome;
          return {
            ...base,
            results: base.results.map((row, i) => ({
              ...row,
              state: ops[i]?.state ?? row.state,
              error: ops[i]?.state === 'failed' ? row.error : row.error,
            })),
          };
        });
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [outcome?.results.length, pendingRows.length]);

  const summary = useMemo(() => {
    if (!rows) return null;
    const bad = rows.filter((r) => r.problem).length;
    return { total: rows.length, bad };
  }, [rows]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setReading(true);
    setLive(null);
    try {
      const parsed = await readEmployeeImportFile(file);
      setRows(validate(parsed, snapshot.users));
      setFileName(file.name);
    } catch (e) {
      setRows(null);
      setFileName('');
      alert((e as Error).message);
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function downloadTemplate() {
    const blob = new Blob([employeeTemplateCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'employee-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const importable = rows?.filter((r) => !r.problem) ?? [];

  return (
    <div className="space-y-6">
      <section className={card + ' space-y-4 p-6'}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">第一步 · 准备数据</h2>
            <p className="mt-1 text-sm text-gray-500">
              下载模板填写后上传，支持 XLSX 或 UTF-8 CSV，单次最多 100 名员工。
              必填列：登录账号、员工姓名、初始密码；其余资料列选填。
            </p>
          </div>
          <button className={button} onClick={downloadTemplate}>
            下载模板
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx"
            aria-label="选择员工清单文件"
            className={input + ' sm:w-96'}
            disabled={!canWrite || reading}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          {fileName && (
            <span className="text-sm text-gray-500">
              {fileName}
              {summary && ` · ${summary.total} 行${summary.bad ? ` · ${summary.bad} 行待修正` : ''}`}
            </span>
          )}
        </div>
      </section>

      {rows && (
        <section className="space-y-3">
          <h2 className="font-semibold">第二步 · 核对预览</h2>
          <DataTable
            label="待导入员工"
            rows={rows}
            rowKey={(r) => r.name}
            searchText={(r) => [r.name, r.display_name, r.department, r.problem].join(' ')}
            actions={
              <button
                className={primary}
                disabled={!canWrite || reading || !importable.length || !!pendingRows.length}
                onClick={() => bulk(importable)}
              >
                导入 {importable.length} 名员工
              </button>
            }
            columns={[
              { label: '登录账号', render: (r) => r.name },
              { label: '员工姓名', render: (r) => r.display_name },
              { label: '部门 / 岗位', render: (r) => `${r.department || '—'} / ${r.title || '—'}` },
              { label: '邮箱', render: (r) => r.email || '—' },
              {
                label: '检查',
                render: (r) =>
                  r.problem ? (
                    <Badge danger>{r.problem}</Badge>
                  ) : (
                    <Badge>可导入</Badge>
                  ),
              },
            ]}
          />
        </section>
      )}

      {outcome && (
        <section className="space-y-3">
          <h2 className="font-semibold">第三步 · 执行结果</h2>
          <p className="text-sm text-gray-500">
            共 {outcome.total} 行：成功提交 {outcome.created} 行
            {pendingRows.length ? `，仍有 ${pendingRows.length} 行在队列中执行，下方状态自动刷新…` : '，全部执行完毕。'}
          </p>
          <DataTable
            label="导入结果"
            rows={outcome.results}
            rowKey={(r) => r.operationId}
            searchText={(r) => `${r.row} ${r.state} ${r.error || ''}`}
            columns={[
              { label: '登录账号', render: (r) => r.row },
              {
                label: '状态',
                render: (r) => (
                  <Badge muted={r.state !== 'succeeded'} danger={r.state === 'failed'}>
                    {r.state === 'succeeded'
                      ? '已创建'
                      : r.state === 'failed'
                        ? '失败'
                        : r.state === 'uncertain'
                          ? '结果待核对'
                          : '执行中'}
                  </Badge>
                ),
              },
              {
                label: '说明',
                render: (r) =>
                  r.error ||
                  (r.state === 'succeeded' ? (
                    <Link className={link} to="/samba/users">
                      查看员工列表 →
                    </Link>
                  ) : (
                    '—'
                  )),
              },
            ]}
          />
        </section>
      )}
    </div>
  );
}
