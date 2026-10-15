import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { OperationError } from '../lib/operation-error';
import { enrollmentRequired, issueStepUp, securityErrorKey, securityStatus, type SecurityStatus, type StepUpPurpose } from '../lib/security-step-up';

type Props = {
  purpose: StepUpPurpose;
  title: string;
  onCancel: () => void;
  onAuthorized: (token: string, password: string) => Promise<void>;
  preferredFocus?: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
};

export default function StepUpDialog({ purpose, title, onCancel, onAuthorized, preferredFocus, fallbackFocus }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState('');
  const [actionRejected, setActionRejected] = useState(false);
  const [operationMessage, setOperationMessage] = useState('');
  const actionStarted = useRef(false);
  const exempt = status?.stepUpExemptPurposes?.includes(purpose) === true;

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let active = true;
    void securityStatus().then((result) => {
      if (active) setStatus(result);
    }).catch(() => {
      if (active) setErrorKey('stepUp.statusFailed');
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => passwordInput.current?.focus() || panel.current?.focus());
    return () => {
      active = false;
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => {
        const previous = returnFocus.current;
        if (preferredFocus?.isConnected && !preferredFocus.closest('[inert]')) preferredFocus.focus();
        else if (previous?.isConnected && previous !== document.body && !previous.closest('[inert]')) previous.focus();
        else if (fallbackFocus?.isConnected) fallbackFocus.focus();
        else document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], main button')?.focus();
      });
    };
  // Capture the opener once; parent state can change while the guarded action runs.
  }, []);
  useEffect(() => {
    if (!status || exempt) return;
    if (enrollmentRequired(status)) panel.current?.querySelector<HTMLElement>('a[href]')?.focus();
    else passwordInput.current?.focus();
  }, [status, exempt]);

  const execute = async () => {
    if (busy) return;
    setErrorKey(''); setOperationMessage(''); setBusy(true);
    try {
      await onAuthorized('', '');
      onCancel();
    } catch (err: unknown) {
      setOperationMessage(err instanceof OperationError ? err.message : '');
      setErrorKey(securityErrorKey(err));
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!exempt || actionStarted.current) return;
    // A render or StrictMode effect replay must never repeat a management write.
    actionStarted.current = true;
    void execute();
  }, [exempt]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!status || busy) return;
    setErrorKey(''); setOperationMessage(''); setActionRejected(false); setBusy(true);
    let verified = false;
    try {
      const token = await issueStepUp(purpose, password, status.enrolled ? code.trim() : undefined);
      verified = true;
      await onAuthorized(token, password);
      setPassword(''); setCode('');
      onCancel();
    } catch (err: unknown) {
      setOperationMessage(err instanceof OperationError ? err.message : '');
      setActionRejected(verified);
      setErrorKey(securityErrorKey(err));
      setCode('');
      requestAnimationFrame(() => (status.enrolled ? codeInput.current : passwordInput.current)?.focus());
    } finally { setBusy(false); }
  };

  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled)') || [])];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  };

  const needsEnrollment = status ? enrollmentRequired(status) : false;
  const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900';
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div ref={panel} data-step-up-dialog={exempt ? undefined : true} data-admin-action={exempt ? true : undefined} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} onKeyDown={trapFocus} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900 sm:p-6">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      {!status ? <p id={`${id}-hint`} role={errorKey ? 'alert' : 'status'} className="mt-4 text-sm">{t(errorKey || 'common.processing')}</p> : exempt ? <>
        <p id={`${id}-hint`} role={errorKey ? 'alert' : 'status'} className="mt-4 text-sm">{operationMessage || t(errorKey || 'common.processing')}</p>
        {errorKey && <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onCancel} className={`min-h-11 rounded-md border border-gray-300 px-4 text-sm dark:border-gray-700 ${focus}`}>{t('common.cancel')}</button></div>}
      </> : <>
      <p id={`${id}-hint`} className="mt-2 text-sm text-gray-600 dark:text-gray-300">{t(status?.passwordSource === 'directory' ? 'stepUp.directoryHint' : 'stepUp.hint')}</p>
      {needsEnrollment ? <div className="mt-4 space-y-4"><p role="alert" className="text-sm text-amber-800 dark:text-amber-300">{t('stepUp.enrollRequired')}</p><Link to="/settings?tab=security" onClick={onCancel} className={`inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm text-white ${focus}`}>{t('stepUp.openSecurity')}</Link></div> : <form onSubmit={submit} className="mt-5 space-y-4">
        <div><label htmlFor={`${id}-password`} className="mb-1 block text-sm font-medium">{t(status?.passwordSource === 'directory' ? 'stepUp.directoryPassword' : 'stepUp.password')}</label><input ref={passwordInput} id={`${id}-password`} type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={`min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 dark:border-gray-700 dark:bg-gray-800 ${focus}`} /></div>
        {status?.enrolled && <div><label htmlFor={`${id}-code`} className="mb-1 block text-sm font-medium">{t('stepUp.code')}</label><input ref={codeInput} id={`${id}-code`} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value)} className={`min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 dark:border-gray-700 dark:bg-gray-800 ${focus}`} /><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('stepUp.codeHint')}</p></div>}
        {errorKey && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{operationMessage || <>{actionRejected && <>{t('stepUp.verifiedActionFailed')} </>}{t(errorKey)} {t(actionRejected ? 'stepUp.actionRecovery' : status ? 'stepUp.recovery' : 'stepUp.statusRecovery')}</>}</p>}
        <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={busy} onClick={onCancel} className={`min-h-11 rounded-md border border-gray-300 px-4 text-sm dark:border-gray-700 ${focus}`}>{t('common.cancel')}</button><button type="submit" disabled={busy || !status} className={`min-h-11 rounded-md bg-brand-700 px-4 text-sm text-white disabled:opacity-60 ${focus}`}>{busy ? t('common.processing') : t('stepUp.verify')}</button></div>
      </form>}
      {needsEnrollment && <button type="button" onClick={onCancel} className={`mt-4 min-h-11 rounded-md border border-gray-300 px-4 text-sm dark:border-gray-700 ${focus}`}>{t('common.cancel')}</button>}
      </>}
    </div>
  </div>, document.body);
}
