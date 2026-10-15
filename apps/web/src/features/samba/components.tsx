import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { Editor, Option } from './types';
export const input =
  'min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-900';
export const button =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800';
export const primary =
  button +
  ' border-transparent bg-brand-700 text-white hover:bg-brand-800 dark:hover:bg-brand-800';
export const card =
  'rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900';
export const link =
  'font-medium text-brand-700 hover:underline dark:text-brand-300';
export function Badge({
  children,
  muted = false,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${muted ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' : 'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-300'}`}
    >
      {children}
    </span>
  );
}
export function Info({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-gray-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium">
        {children || '未填写'}
      </dd>
    </div>
  );
}
export function DataTable<T>({
  label,
  rows,
  columns,
  rowKey,
  searchText,
  actions,
  filters,
  empty = '暂无记录',
}: {
  label: string;
  rows: T[];
  columns: { label: ReactNode; render: (row: T) => ReactNode; className?: string }[];
  rowKey: (row: T) => string;
  searchText?: (row: T) => string;
  actions?: ReactNode;
  filters?: ReactNode;
  empty?: string;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const filtered = searchText
    ? rows.filter((r) =>
        searchText(r).toLowerCase().includes(query.trim().toLowerCase()),
      )
    : rows;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * size, current * size);
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 p-4 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-3">
          {searchText && (
            <input
              type="search"
              aria-label={`搜索${label}`}
              placeholder={`搜索${label}`}
              className={input + ' sm:w-72'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          )}
          {filters}
        </div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
      <div className="overflow-x-auto">
        <table aria-label={label} className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-500 dark:bg-gray-950/40">
            <tr>
              {columns.map((c, i) => (
                <th
                  scope="col"
                  key={i}
                  className={'whitespace-nowrap px-4 py-3 font-medium ' + (c.className || '')}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={rowKey(r)}
                className="border-t border-gray-100 hover:bg-gray-50/70 dark:border-gray-800 dark:hover:bg-gray-800/30"
              >
                {columns.map((c, i) => (
                  <td key={i} className={'px-4 py-4 align-top ' + (c.className || '')}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <p className="px-4 py-12 text-center text-sm text-gray-500">
            {empty}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-3 text-sm text-gray-500 dark:border-gray-800">
        <span>
          共 {filtered.length} 条 · 第 {current} / {pages} 页
        </span>
        <div className="flex items-center gap-2">
          <select
            aria-label="每页条数"
            value={size}
            className="rounded-md border bg-transparent p-2 dark:border-gray-700"
            onChange={(e) => {
              setSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} 条 / 页
              </option>
            ))}
          </select>
          <button
            className={button}
            disabled={current === 1}
            onClick={() => setPage(current - 1)}
          >
            上一页
          </button>
          <button
            className={button}
            disabled={current === pages}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
export function MultiPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = options.filter((o) =>
    o.label.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <input
        className={input}
        aria-label={`搜索${label}`}
        type="search"
        placeholder="按姓名、账号、工号或部门搜索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>已选择 {value.length} 项</span>
        <button
          type="button"
          className={link}
          onClick={() =>
            onChange([...new Set([...value, ...visible.map((o) => o.value)])])
          }
        >
          全选搜索结果
        </button>
        <button type="button" className={link} onClick={() => onChange([])}>
          清空选择
        </button>
      </div>
      <div className="max-h-60 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
        {visible.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-start gap-3 rounded-md p-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <input
              type="checkbox"
              className="mt-1"
              value={o.value}
              aria-label={o.label}
              checked={value.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, o.value]
                    : value.filter((v) => v !== o.value),
                )
              }
            />
            <span className="break-words">{o.label}</span>
          </label>
        ))}
        {!visible.length && (
          <p className="p-4 text-sm text-gray-500">没有可选择的记录</p>
        )}
      </div>
    </fieldset>
  );
}
export function EditorDialog({
  editor,
  setEditor,
  submit,
  cancel,
  busy = false,
  submitLabel = '确认并验证身份',
}: {
  editor: Editor;
  setEditor: (value: Editor) => void;
  submit: (e: FormEvent) => void;
  cancel: () => void;
  busy?: boolean;
  submitLabel?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const update = (name: string, value: unknown) =>
    setEditor({ ...editor, values: { ...editor.values, [name]: value } });
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={editor.title}
        className={card + ' max-h-[90dvh] w-full max-w-2xl overflow-auto p-6'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if (e.key !== 'Tab') return;
          const items = [
            ...(ref.current?.querySelectorAll<HTMLElement>(
              'input:not(:disabled),select:not(:disabled),button:not(:disabled)',
            ) || []),
          ];
          if (e.shiftKey && document.activeElement === items[0]) {
            e.preventDefault();
            items.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
            e.preventDefault();
            items[0]?.focus();
          }
        }}
      >
        <h2 className="text-lg font-semibold">{editor.title}</h2>
        {editor.description && (
          <p className="mt-2 text-sm text-gray-500">{editor.description}</p>
        )}
        <form onSubmit={submit} className="mt-5 space-y-4">
          {editor.error && <p role="alert" className="text-sm text-red-600">{editor.error}</p>}
          {editor.fields.map((f) =>
            f.type === 'multi' ? (
              <MultiPicker
                key={f.name}
                label={f.label}
                options={f.options || []}
                value={(editor.values[f.name] || []) as string[]}
                onChange={(v) => update(f.name, v)}
              />
            ) : (
              <label className="block space-y-1 text-sm" key={f.name}>
                <span>
                  {f.label}
                  {f.optional && (
                    <span className="ml-2 text-xs text-gray-400">选填</span>
                  )}
                </span>
                {f.type === 'checkbox' ? (
                  <input
                    className="ml-3"
                    type="checkbox"
                    checked={!!editor.values[f.name]}
                    onChange={(e) => update(f.name, e.target.checked)}
                  />
                ) : f.type === 'select' ? (
                  <select
                    aria-label={f.label}
                    className={input}
                    value={String(editor.values[f.name] || '')}
                    onChange={(e) => update(f.name, e.target.value)}
                  >
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={f.label}
                    className={input}
                    type={f.type || 'text'}
                    autoComplete={
                      f.type === 'password' ? 'new-password' : 'off'
                    }
                    required={!f.optional}
                    minLength={f.minLength}
                    maxLength={
                      f.maxLength || (f.type === 'password' ? 512 : 128)
                    }
                    value={String(editor.values[f.name] || '')}
                    onChange={(e) => update(f.name, e.target.value)}
                  />
                )}
                {f.hint && <span className="block text-xs text-gray-500">{f.hint}</span>}
              </label>
            ),
          )}
          <div className="flex justify-end gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
            <button type="button" className={button} onClick={cancel} disabled={busy}>
              取消
            </button>
            <button className={primary} type="submit" disabled={busy}>
              {busy ? '正在处理…' : submitLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
