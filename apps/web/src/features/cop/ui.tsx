import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, apiOrigin } from '../../lib/api';
import { localeOf } from '../../i18n';
import { requestError, useCopQuery } from './api';

export const panel =
  'rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900';
export const button =
  'rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
export const secondary =
  'rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 disabled:opacity-50';
export const input =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950';
export function PageHeading({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {hint && <p className="mt-2 text-sm text-gray-500">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
export function Failure({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => unknown;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="my-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950"
    >
      {requestError(error)}{' '}
      {retry && (
        <button className="underline" onClick={() => retry()}>
          {t('cop.retry')}
        </button>
      )}
    </div>
  );
}
export function Pager({
  page,
  total,
  pageSize = 20,
  onChange,
}: {
  page: number;
  total: number;
  pageSize?: number;
  onChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
      <span>
        {page} / {Math.max(1, Math.ceil(total / pageSize))} · {total}
      </span>
      <div className="flex gap-2">
        <button
          className={secondary}
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          {t('cop.previous')}
        </button>
        <button
          className={secondary}
          disabled={page * pageSize >= total}
          onClick={() => onChange(page + 1)}
        >
          {t('cop.next')}
        </button>
      </div>
    </div>
  );
}
export function Status({ value }: { value: string }) {
  const { t } = useTranslation();
  return (
    <span className="rounded-md bg-gray-100 px-2 py-1 text-xs dark:bg-gray-800">
      {t('cop.' + value, { defaultValue: value })}
    </span>
  );
}
export interface Field {
  key: string;
  label?: string;
  type?: 'text' | 'number' | 'date' | 'checkbox' | 'textarea' | 'select';
  required?: boolean;
  readonly?: boolean;
  options?: { value: string; label: string }[];
}
export function ResourceForm({
  title,
  fields,
  initial,
  onSave,
  onClose,
  hint,
  extra,
}: {
  title: string;
  fields: Field[];
  initial: Record<string, any>;
  onSave: (data: Record<string, any>) => Promise<unknown>;
  onClose: () => void;
  hint?: string;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, any>>({ ...initial });
  const formRef = useRef<HTMLFormElement>(null);
  const mutation = useMutation({ mutationFn: onSave, onSuccess: onClose });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    formRef.current
      ?.querySelector<HTMLElement>('input,select,textarea,button')
      ?.focus();
    return () => previous?.focus();
  }, []);
  function keydown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && !mutation.isPending) onClose();
    if (e.key === 'Tab') {
      const nodes = Array.from(
        formRef.current?.querySelectorAll<HTMLElement>(
          'input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])',
        ) ?? [],
      );
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const data: Record<string, any> = {};
    for (const f of fields) {
      const value = values[f.key];
      data[f.key] =
        f.type === 'checkbox'
          ? !!value
          : f.type === 'number' && value !== '' && value != null
            ? Number(value)
            : value === '' || value == null
              ? undefined
              : value;
    }
    mutation.mutate(data);
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={keydown}
    >
      <form
        ref={formRef}
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900"
      >
        <h2 className="text-xl font-semibold">{title}</h2>
        {hint && <p className="mt-2 text-sm text-gray-500">{hint}</p>}
        {extra}
        <div className="my-5 grid gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <label
              key={f.key}
              className={f.type === 'textarea' ? 'sm:col-span-2' : ''}
            >
              <span className="mb-1 block text-sm">
                {t('cop.' + (f.label ?? f.key))}
                {f.required ? ' *' : ''}
              </span>
              {f.type === 'select' ? (
                <select
                  aria-label={t('cop.' + (f.label ?? f.key))}
                  className={input}
                  value={values[f.key] ?? ''}
                  required={f.required}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                >
                  {
                    <option value="">
                      {t(f.required ? 'cop.chooseOne' : 'cop.optional')}
                    </option>
                  }
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea
                  className={input}
                  rows={3}
                  required={f.required}
                  maxLength={4000}
                  value={values[f.key] ?? ''}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                />
              ) : f.type === 'checkbox' ? (
                <input
                  type="checkbox"
                  checked={!!values[f.key]}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.checked })
                  }
                />
              ) : (
                <input
                  className={input}
                  type={f.type ?? 'text'}
                  min={f.type === 'number' ? 0 : undefined}
                  maxLength={f.key === 'description' ? 4000 : 160}
                  readOnly={f.readonly}
                  required={f.required}
                  value={
                    f.type === 'date'
                      ? String(values[f.key] ?? '').split('T')[0]
                      : (values[f.key] ?? '')
                  }
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
        </div>
        {mutation.isError && <Failure error={mutation.error} />}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className={secondary}
            disabled={mutation.isPending}
            onClick={onClose}
          >
            {t('cop.cancel')}
          </button>
          <button
            type="submit"
            className={button}
            disabled={mutation.isPending}
          >
            {t('cop.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
export function Files({
  kind,
  id,
  canWrite,
}: {
  kind: string;
  id: string;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const files = useCopQuery<
    { id: string; fileName: string; fileSize: number; url: string }[]
  >('/operations/' + kind + '/' + id + '/attachments');
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 512 * 1024 * 1024) throw Error('512 MiB maximum');
      const data = new FormData();
      data.append('file', file);
      return api.post('/operations/' + kind + '/' + id + '/attachments', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cop'] }),
  });
  return (
    <section className={panel}>
      <h2 className="mb-3 font-semibold">{t('cop.attachments')}</h2>
      {files.isError && <Failure error={files.error} />}
      <ul className="space-y-2 text-sm">
        {files.data?.map((f) => (
          <li key={f.id}>
            <a
              className="text-brand-700 underline dark:text-brand-300"
              href={apiOrigin + '/api' + f.url}
            >
              {f.fileName}
            </a>{' '}
            <span className="text-gray-400">
              {Math.ceil(f.fileSize / 1024)} KB
            </span>
          </li>
        ))}
      </ul>
      {files.data?.length === 0 && (
        <p className="text-sm text-gray-400">{t('cop.empty')}</p>
      )}
      {canWrite && (
        <label className="mt-4 block text-sm">
          {t('cop.upload')}
          <input
            className="mt-2 block max-w-full text-sm"
            type="file"
            disabled={upload.isPending}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = '';
            }}
          />
        </label>
      )}
      {upload.isError && <Failure error={upload.error} />}
    </section>
  );
}
export function Activity({ kind, id }: { kind: string; id: string }) {
  const { t, i18n } = useTranslation();
  const entries = useCopQuery<any[]>(
    '/operations/' + kind + '/' + id + '/activity',
  );
  const labels = [
    'code',
    'name',
    'category',
    'manufacturer',
    'model',
    'serialNumber',
    'location',
    'status',
    'purchaseCost',
    'currency',
    'ownerName',
    'ownership',
    'rackName',
    'rackUnit',
    'labelVerified',
    'sku',
    'unit',
    'minimumStock',
    'active',
  ];
  function title(action: string) {
    return ['CREATE', 'IMPORT_CREATE'].includes(action)
      ? t('cop.created')
      : ['UPDATE', 'IMPORT_UPDATE', 'MEMBER_CHANGED'].includes(action)
        ? t('cop.updated')
        : action === 'REGISTER'
          ? t('cop.assignNumber')
          : action === 'LINK_TICKET'
            ? t('cop.linked')
            : action === 'UNLINK_TICKET'
              ? t('cop.unlinked')
              : action === 'ATTACHMENT_ADDED'
                ? t('cop.fileAdded')
                : t('cop.' + action.replace('STOCK_', ''), {
                    defaultValue: t('cop.stockPosted'),
                  });
  }
  const value = (v: any) =>
    typeof v === 'boolean'
      ? t(v ? 'cop.active' : 'cop.inactive')
      : v == null
        ? '—'
        : t('cop.' + String(v), { defaultValue: String(v) });
  return (
    <section className={panel}>
      <h2 className="mb-4 font-semibold">{t('cop.history')}</h2>
      {entries.isError && <Failure error={entries.error} />}
      <ol className="space-y-4">
        {entries.data?.map((e) => (
          <li
            key={e.id}
            className="border-l-2 border-brand-200 pl-3 text-sm dark:border-brand-900"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <span>
                {e.actorName} · {title(e.action)}
              </span>
              <time className="text-xs text-gray-400">
                {new Date(e.createdAt).toLocaleString(localeOf(i18n.language))}
              </time>
            </div>
            {e.after?.reason && (
              <p className="mt-1 text-gray-500">{e.after.reason}</p>
            )}
            {['UPDATE', 'IMPORT_UPDATE'].includes(e.action) &&
              labels
                .filter((k) => e.before?.[k] !== e.after?.[k])
                .map((k) => (
                  <p className="mt-1 text-xs text-gray-500" key={k}>
                    {t('cop.' + k)}: {value(e.before?.[k])} →{' '}
                    {value(e.after?.[k])}
                  </p>
                ))}
          </li>
        ))}
      </ol>
      {entries.data?.length === 0 && (
        <p className="text-sm text-gray-400">{t('cop.empty')}</p>
      )}
    </section>
  );
}
