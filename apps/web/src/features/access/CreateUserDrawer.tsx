import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { guardedApi, securityErrorKey } from '../../lib/security-step-up';
import RoleSelector from './RoleSelector';
import { toggleRoleSelection, type AssignableRole } from './role-selection';
import { invalidUserField, newUserPayload, type NewUserForm } from './user-directory';

interface Props {
  roles: AssignableRole[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onCreated: () => void;
}

export default function CreateUserDrawer({ roles, loading, failed, onRetry, onCancel, onCreated }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const fields = useRef<HTMLFormElement>(null);
  const saving = useRef(false);
  const [step, setStep] = useState<0 | 1>(0);
  const [form, setForm] = useState<NewUserForm>({ name: '', email: '', password: '', roleNames: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('input:not(:disabled)')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [step]);

  const close = () => { if (!saving.current) onCancel(); };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), summary') ?? [])];
    if (!controls.length) { event.preventDefault(); panel.current?.focus(); }
    else if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel.current)) {
      event.preventDefault(); controls.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving.current) return;
    const invalid = invalidUserField(form);
    if (invalid) {
      setError(`access.create.${invalid}Hint`);
      if (step !== 0) setStep(0);
      else fields.current?.querySelector<HTMLInputElement>(`[name="${invalid}"]`)?.focus();
      return;
    }
    if (step === 0) { setError(''); setStep(1); return; }
    if (!form.roleNames.length || loading || failed) return;
    saving.current = true; setBusy(true); setError('');
    panel.current?.focus();
    try {
      await guardedApi('POST', '/users', '', newUserPayload(form));
    } catch (failure) {
      setError(securityErrorKey(failure));
      saving.current = false; setBusy(false);
      return;
    }
    // Closing unmounts the form; no password or unfinished draft is persisted.
    onCreated();
  };

  const inputClass = 'min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base sm:text-sm dark:border-gray-600 dark:bg-gray-950';
  return <div className="fixed inset-0 z-[60] flex justify-end bg-black/40" onClick={close}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} tabIndex={-1}
      onClick={event => event.stopPropagation()} onKeyDown={keys}
      className="flex h-dvh w-full flex-col border-l border-gray-200 bg-white shadow-xl sm:max-w-4xl dark:border-gray-700 dark:bg-gray-900">
      <header className="shrink-0 border-b border-gray-200 px-4 py-5 sm:px-6 dark:border-gray-700">
        <div className="flex items-center justify-between gap-3">
          <h2 id={`${id}-title`} className="text-lg font-semibold">{t('users.create')}</h2>
          <button type="button" disabled={busy} onClick={close} aria-label={t('common.close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800">
            <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <p id={`${id}-hint`} className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-400">{t('access.create.hint')}</p>
        <ol aria-label={t('access.create.steps')} className="mt-5 flex gap-4 text-sm">
          {(['basics', 'roles'] as const).map((key, index) => <li key={key} aria-current={step === index ? 'step' : undefined}
            className={`flex min-w-0 flex-1 items-center gap-2 border-b-2 pb-3 ${step === index ? 'border-brand-600 font-medium text-brand-800 dark:text-brand-300' : 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400'}`}>
            <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${step === index ? 'bg-brand-700 text-white' : 'bg-gray-100 dark:bg-gray-800'}`}>{index + 1}</span>{t(`access.create.${key}`)}
          </li>)}
        </ol>
      </header>
      <form ref={fields} onSubmit={event => void submit(event)} className="flex min-h-0 flex-1 flex-col" aria-busy={busy}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {step === 0 ? <div className="max-w-xl space-y-5">
            <h3 className="font-medium">{t('access.create.basics')}</h3>
            <label className="grid gap-2 text-sm font-medium">{t('users.namePlaceholder')}<input name="name" required minLength={2} autoComplete="off" value={form.name} disabled={busy}
              onChange={event => { setForm({ ...form, name: event.target.value }); setError(''); }} className={inputClass} aria-describedby={`${id}-name-hint`} />
              <span id={`${id}-name-hint`} className="text-xs font-normal text-gray-500 dark:text-gray-400">{t('access.create.nameHint')}</span>
            </label>
            <label className="grid gap-2 text-sm font-medium">{t('users.emailPlaceholder')}<input name="email" type="email" required autoComplete="off" value={form.email} disabled={busy}
              onChange={event => { setForm({ ...form, email: event.target.value }); setError(''); }} className={inputClass} />
            </label>
            <label className="grid gap-2 text-sm font-medium">{t('users.passwordPlaceholder')}<input name="password" type="password" required minLength={6} autoComplete="new-password" value={form.password} disabled={busy}
              onChange={event => { setForm({ ...form, password: event.target.value }); setError(''); }} className={inputClass} aria-describedby={`${id}-password-hint`} />
              <span id={`${id}-password-hint`} className="text-xs font-normal text-gray-500 dark:text-gray-400">{t('access.create.passwordHint')}</span>
            </label>
          </div> : <div className="space-y-4">
            <div className="rounded-md bg-gray-50 px-4 py-3 dark:bg-gray-800"><p className="break-words text-sm font-medium">{form.name.trim()}</p><p className="mt-1 break-all text-xs text-gray-600 dark:text-gray-400">{form.email.trim()}</p></div>
            <RoleSelector roles={roles} selected={form.roleNames} onToggle={name => setForm(previous => ({ ...previous, roleNames: toggleRoleSelection(previous.roleNames, name) }))}
              disabled={busy} loading={loading} failed={failed} onRetry={onRetry} />
            <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">{t('access.readonly')}</p>
          </div>}
        </div>
        <footer className="shrink-0 border-t border-gray-200 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-6 dark:border-gray-700 dark:bg-gray-900">
          {error && <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">{t(error)}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" disabled={busy} onClick={close} className="min-h-11 rounded-md border border-gray-300 px-4 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800">{t('common.cancel')}</button>
            <div className="flex gap-2">
              {step === 1 && <button type="button" disabled={busy} onClick={() => { setStep(0); setError(''); }} className="min-h-11 rounded-md border border-gray-300 px-4 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800">{t('access.create.back')}</button>}
              <button type="submit" disabled={busy || (step === 1 && (loading || failed || !form.roleNames.length))}
                className="min-h-11 rounded-md bg-brand-700 px-4 text-sm text-white hover:bg-brand-800 disabled:opacity-50">{t(busy ? 'common.processing' : step === 0 ? 'access.create.next' : 'users.create')}</button>
            </div>
          </div>
        </footer>
      </form>
    </div>
  </div>;
}
