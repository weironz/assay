import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useDatacenters } from '../features/tickets/api';
import { useAuth } from '../stores/auth';

const input =
  'min-h-11 min-w-0 rounded-md border border-gray-300 bg-transparent px-3 text-sm focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-700';
const button =
  'min-h-11 rounded-md border border-gray-300 px-3 text-sm disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-700';

function DatacenterRow({
  item,
  busy,
  save,
  remove,
}: {
  item: { id: string; name: string };
  busy: boolean;
  save: (id: string, name: string) => void;
  remove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(item.name);
  useEffect(() => setName(item.name), [item.name]);
  return (
    <li className="flex flex-wrap gap-2 border-t border-gray-100 py-3 dark:border-gray-800">
      <label className="min-w-36 flex-1">
        <span className="sr-only">
          {t('ticketUi.name')}: {item.name}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          disabled={busy}
          className={`${input} w-full`}
        />
      </label>
      <button
        className={button}
        disabled={busy || name.trim() === item.name}
        onClick={() => save(item.id, name)}
      >
        {t('common.save')}
      </button>
      <button
        className={`${button} text-red-600 dark:text-red-400`}
        disabled={busy}
        onClick={() => remove(item.id)}
        aria-label={`${t('common.delete')} ${item.name}`}
      >
        {t('common.delete')}
      </button>
    </li>
  );
}

export default function TicketFieldsSettings() {
  const { t } = useTranslation();
  const admin = useAuth((s) => s.hasRole('admin') && s.has('user:manage'));
  const query = useDatacenters();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  if (!admin) return <p role="alert">{t('ticketUi.forbidden')}</p>;
  const write = async (
    method: 'post' | 'patch' | 'delete',
    id?: string,
    value?: string,
  ) => {
    if (busy) return;
    setMessage('');
    setFailed(false);
    if (method !== 'delete' && (!value?.trim() || value.trim().length > 80)) {
      setFailed(true);
      setMessage('ticketUi.required');
      return;
    }
    setBusy(true);
    try {
      await api.request({
        method,
        url: `/datacenters${id ? `/${id}` : ''}`,
        ...(method !== 'delete' ? { data: { name: value!.trim() } } : {}),
      });
      if (method === 'post') setName('');
      await Promise.all(
        ['datacenters', 'tickets', 'ticket'].map((key) =>
          qc.invalidateQueries({ queryKey: [key] }),
        ),
      );
      setMessage('ticketUi.saved');
    } catch (error: any) {
      setFailed(true);
      setMessage(
        error.response?.status === 409
          ? 'ticketUi.conflict'
          : error.response?.status === 403
            ? 'ticketUi.forbidden'
            : 'ticketUi.failed',
      );
    } finally {
      setBusy(false);
    }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    void write('post', undefined, name);
  };
  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="font-semibold">{t('ticketUi.manage')}</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('ticketUi.fieldsHint')}
      </p>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 text-sm">
          <span className="mb-1 block">{t('ticketUi.name')}</span>
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className={`${input} w-full`}
          />
        </label>
        <button disabled={busy} className={`${button} bg-brand-700 text-white`}>
          {t('ticketUi.add')}
        </button>
      </form>
      {message && (
        <p
          role={failed ? 'alert' : 'status'}
          className={`text-sm ${failed ? 'text-red-600 dark:text-red-400' : 'text-brand-700 dark:text-brand-300'}`}
        >
          {t(message)}
        </p>
      )}
      {query.isLoading && <p role="status">{t('common.loading')}</p>}
      {query.isError && (
        <p role="alert">
          {t('ticketUi.failed')}{' '}
          <button className={button} onClick={() => void query.refetch()}>
            {t('ticketAttributes.retry')}
          </button>
        </p>
      )}
      <ul>
        {query.data?.map((item) => (
          <DatacenterRow
            key={item.id}
            item={item}
            busy={busy}
            save={(id, value) => void write('patch', id, value)}
            remove={(id) => void write('delete', id)}
          />
        ))}
      </ul>
      {!query.isLoading && query.data?.length === 0 && (
        <p className="text-sm text-gray-500">{t('ticketUi.empty')}</p>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('ticketUi.removeHint')}
      </p>
    </section>
  );
}
