import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useCreateTicketShare,
  useRevokeTicketShare,
  useTicketShares,
} from '../features/tickets/api';
import { useDateFormat } from '../i18n/format';

type Expiry = '1' | '7' | '30' | '90' | 'never';

function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
  return Promise.resolve();
}

export default function TicketShareDialog({
  ticketId,
  open,
  onClose,
}: {
  ticketId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { data: shares } = useTicketShares(ticketId, open);
  const create = useCreateTicketShare();
  const revoke = useRevokeTicketShare();
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('7');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const createShare = () => {
    setError(null);
    setCopied(false);
    create.mutate(
      {
        ticketId,
        label: label.trim() || undefined,
        expiresInDays: expiry === 'never' ? undefined : Number(expiry),
      },
      {
        onSuccess: (share) => {
          setCreatedUrl(`${window.location.origin}/share/${share.token}`);
          setLabel('');
        },
        onError: () => setError(t('share.createFailed')),
      },
    );
  };

  const copy = async () => {
    if (!createdUrl) return;
    try {
      await copyText(createdUrl);
      setCopied(true);
    } catch {
      setError(t('share.copyFailed'));
    }
  };

  const revokeShare = (shareId: string) => {
    if (!window.confirm(t('share.revokeConfirm'))) return;
    revoke.mutate(
      { ticketId, shareId },
      { onError: () => setError(t('share.revokeFailed')) },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-gray-950/45 p-0 sm:items-center sm:justify-center sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ticket-share-title"
        tabIndex={-1}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-xl border border-gray-200 bg-white shadow-xl outline-none dark:border-gray-700 dark:bg-gray-900 sm:max-w-lg sm:rounded-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <div>
            <h2 id="ticket-share-title" className="font-semibold text-gray-900 dark:text-gray-100">
              {t('share.title')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
              {t('share.intro')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md px-2 py-1 text-lg leading-none text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {error && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </p>
          )}

          {createdUrl && (
            <section className="rounded-lg border border-brand-200 bg-brand-50 p-3 dark:border-brand-900/70 dark:bg-brand-950/30">
              <p className="text-sm font-medium text-brand-800 dark:text-brand-200">{t('share.createdTitle')}</p>
              <p className="mt-1 text-xs leading-5 text-brand-700 dark:text-brand-300">{t('share.createdHint')}</p>
              <div className="mt-3 flex gap-2">
                <input
                  readOnly
                  value={createdUrl}
                  aria-label={t('share.linkLabel')}
                  className="min-w-0 flex-1 rounded-md border border-brand-200 bg-white px-2.5 py-2 text-xs text-gray-700 dark:border-brand-800 dark:bg-gray-950 dark:text-gray-200"
                />
                <button
                  type="button"
                  onClick={copy}
                  className="shrink-0 rounded-md bg-brand-700 px-3 py-2 text-sm text-white transition-colors hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {copied ? t('share.copied') : t('share.copy')}
                </button>
              </div>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-gray-800 dark:text-gray-100">{t('share.createTitle')}</h3>
            <label className="block text-sm text-gray-600 dark:text-gray-300">
              {t('share.nameLabel')}
              <input
                value={label}
                maxLength={80}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('share.namePlaceholder')}
                className="mt-1.5 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-shadow focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-gray-700 dark:bg-gray-800 dark:focus:ring-brand-950"
              />
            </label>
            <label className="block text-sm text-gray-600 dark:text-gray-300">
              {t('share.expiryLabel')}
              <select
                value={expiry}
                onChange={(event) => setExpiry(event.target.value as Expiry)}
                className="mt-1.5 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-gray-700 dark:bg-gray-800 dark:focus:ring-brand-950"
              >
                <option value="1">{t('share.expiry1')}</option>
                <option value="7">{t('share.expiry7')}</option>
                <option value="30">{t('share.expiry30')}</option>
                <option value="90">{t('share.expiry90')}</option>
                <option value="never">{t('share.expiryNever')}</option>
              </select>
            </label>
            <button
              type="button"
              disabled={create.isPending}
              onClick={createShare}
              className="w-full rounded-md bg-brand-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {create.isPending ? t('common.processing') : t('share.create')}
            </button>
          </section>

          <section className="border-t border-gray-100 pt-4 dark:border-gray-800">
            <h3 className="text-sm font-medium text-gray-800 dark:text-gray-100">{t('share.existingTitle')}</h3>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{t('share.existingHint')}</p>
            {shares?.length ? (
              <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                {shares.map((share) => (
                  <li key={share.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-gray-700 dark:text-gray-200">{share.label}</p>
                      <p className="mt-0.5 text-xs text-gray-400">
                        {share.expiresAt
                          ? t('share.expiresAt', { date: fmt.dateTime(share.expiresAt) })
                          : t('share.neverExpires')}
                      </p>
                    </div>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${
                      share.status === 'ACTIVE'
                        ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                        : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                    }`}>
                      {t(`share.status.${share.status}`)}
                    </span>
                    {share.status === 'ACTIVE' && (
                      <button
                        type="button"
                        onClick={() => revokeShare(share.id)}
                        disabled={revoke.isPending}
                        className="rounded px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30"
                      >
                        {t('share.revoke')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-gray-300 px-3 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">{t('share.empty')}</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
