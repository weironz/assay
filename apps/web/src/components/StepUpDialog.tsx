import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { OperationError } from '../lib/operation-error';
import { securityErrorKey, type StepUpPurpose } from '../lib/security-step-up';

type Props = {
  purpose: StepUpPurpose;
  title: string;
  onCancel: () => void;
  onAuthorized: (token: string, password: string) => Promise<void>;
  preferredFocus?: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
  preview?: [string, string][];
  requirePassword?: boolean;
};

/** Compatibility entry point: normal actions execute with the current session.
 * No modal, portal, extra credential request, or automatic failure retry.
 * Passwords required by Better Auth itself are collected inline, once. */
export default function StepUpDialog({
  purpose,
  title,
  onCancel,
  onAuthorized,
  requirePassword = purpose === 'two-factor',
}: Props) {
  const { t } = useTranslation();
  const id = useId();
  const started = useRef(false);
  const executing = useRef(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const execute = async (value: string) => {
    if (executing.current) return;
    executing.current = true;
    setBusy(true);
    setError('');
    try {
      await onAuthorized('', value);
      setPassword('');
      onCancel();
    } catch (failure) {
      setError(
        failure instanceof OperationError
          ? failure.message
          : t(securityErrorKey(failure)),
      );
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!requirePassword && !started.current) {
      started.current = true;
      void execute('');
    }
  }, []);
  if (!requirePassword && !error)
    return busy ? (
      <p role="status" className="text-sm text-gray-500">
        {t('common.processing')}
      </p>
    ) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) void execute(password);
  };
  return (
    <section
      aria-label={title}
      className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
    >
      {requirePassword && (
        <form onSubmit={submit} className="space-y-3">
          <h3 className="text-sm font-medium">{title}</h3>
          <label htmlFor={id} className="block text-sm">
            {t('profile.currentPassword')}
          </label>
          <input
            id={id}
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-h-11 w-full rounded-md border border-gray-300 bg-transparent px-3 focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-700"
          />
          <button
            disabled={busy}
            className="min-h-11 rounded-md bg-brand-700 px-4 text-sm text-white disabled:opacity-50"
          >
            {busy ? t('common.processing') : title}
          </button>
        </form>
      )}
      {error && (
        <p
          role="alert"
          className="break-words text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
      {!requirePassword && error && (
        <button
          className="min-h-11 rounded border border-gray-300 px-3 text-sm dark:border-gray-700"
          onClick={() => void execute('')}
          disabled={busy}
        >
          {t('ticketAttributes.retry')}
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        className="min-h-11 rounded px-3 text-sm focus-visible:ring-2 focus-visible:ring-brand-500"
        onClick={onCancel}
      >
        {t('common.cancel')}
      </button>
    </section>
  );
}
