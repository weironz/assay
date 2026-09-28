import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'react-qr-code';
import { api } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { useAuth, type AuthUser } from '../stores/auth';
import StepUpDialog from './StepUpDialog';
import { enrollmentRequired, SecurityRequestError, securityErrorKey, securityStatus, stepUpHeaders, type SecurityStatus } from '../lib/security-step-up';

const input = 'min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-700 dark:bg-gray-800';
const button = 'min-h-11 rounded-md bg-brand-700 px-4 py-2 text-sm text-white hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60';

type Setup = { uri: string; codes: string[] };

export default function TwoFactorSettings() {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [challenge, setChallenge] = useState<'disable' | 'regenerate' | null>(null);
  const enabled = !!user?.twoFactorEnabled;
  useEffect(() => { void securityStatus().then(setSecurity).catch(() => {}); }, [enabled]);

  const refreshAfterSuccess = async (twoFactorEnabled: boolean) => {
    if (user) setUser({ ...user, twoFactorEnabled });
    try {
      const { data } = await api.get<AuthUser>('/me');
      setUser(data);
    } catch {
      setRefreshWarning(true);
    }
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice(''); setRefreshWarning(false);
    try { await task(); }
    catch (err) { setError(t(securityErrorKey(err, 'twoFactor.failed'))); }
    finally { setBusy(false); }
  };

  const begin = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.twoFactor.enable({ password });
      if (result.error || !result.data) throw new SecurityRequestError(result.error?.status);
      setSetup({ uri: result.data.totpURI, codes: result.data.backupCodes });
      setPassword('');
    });
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (!setup) return;
    void run(async () => {
      const result = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (result.error) throw new SecurityRequestError(result.error.status);
      setBackupCodes(setup.codes);
      setSetup(null); setCode('');
      setNotice(t('twoFactor.enabled'));
      await refreshAfterSuccess(true);
    });
  };

  const completeChallenge = async (token: string, verifiedPassword: string) => {
    setRefreshWarning(false);
    if (challenge === 'disable') {
      const result = await authClient.twoFactor.disable({ password: verifiedPassword }, { headers: stepUpHeaders(token) });
      if (result.error) throw new SecurityRequestError(result.error.status);
      setPassword(''); setSetup(null); setBackupCodes(null);
      setNotice(t('twoFactor.disabled'));
      await refreshAfterSuccess(false);
    } else if (challenge === 'regenerate') {
      const result = await authClient.twoFactor.generateBackupCodes({ password: verifiedPassword }, { headers: stepUpHeaders(token) });
      if (result.error || !result.data) throw new SecurityRequestError(result.error?.status);
      setBackupCodes(result.data.backupCodes);
      setNotice(t('twoFactor.regenerated'));
    }
  };

  const secret = setup ? new URL(setup.uri).searchParams.get('secret') : null;

  return <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
    <div><h2 className="font-medium">{t('twoFactor.title')}</h2><p className="mt-1 text-sm text-gray-500">{t('twoFactor.intro')}</p></div>
    <p className={`text-sm font-medium ${enabled ? 'text-green-700 dark:text-green-400' : 'text-gray-500'}`}>{t(enabled ? 'twoFactor.statusOn' : 'twoFactor.statusOff')}</p>
    {security && enrollmentRequired(security) && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{t('stepUp.enrollRequired')}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
    {refreshWarning && <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('twoFactor.refreshFailed')}</p>}
    {!enabled && !setup && <form onSubmit={begin} className="space-y-3">
      <label className="block text-sm" htmlFor="two-factor-enable-password">{t('twoFactor.password')}</label>
      <input id="two-factor-enable-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
      <button disabled={busy} className={button}>{t('twoFactor.start')}</button>
    </form>}
    {setup && !enabled && <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('twoFactor.scanHint')}</p>
      <div className="inline-block rounded-lg bg-white p-3"><QRCode value={setup.uri} size={176} /></div>
      <div><p className="text-xs text-gray-500">{t('twoFactor.manualKey')}</p><code className="block break-all text-sm select-all">{secret}</code></div>
      <form onSubmit={confirm} className="space-y-3">
        <label className="block text-sm" htmlFor="two-factor-setup-code">{t('twoFactor.code')}</label>
        <input id="two-factor-setup-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} className={input} />
        <button disabled={busy} className={button}>{t('twoFactor.confirm')}</button>
      </form>
      <p className="text-xs text-gray-500">{t('twoFactor.setupWarning')}</p>
    </div>}
    {enabled && !backupCodes && <div className="space-y-4">
      <p className="text-xs text-gray-500">{t('twoFactor.apiTokenNotice')}</p>
      <div className="space-y-2"><p className="text-sm text-gray-500 dark:text-gray-400">{t('twoFactor.regenerateHint')}</p><button type="button" onClick={() => setChallenge('regenerate')} disabled={busy} className={`${button} min-h-11 focus-visible:ring-2 focus-visible:ring-brand-500`}>{t('twoFactor.regenerate')}</button></div>
      <div className="space-y-2 border-t border-gray-200 pt-4 dark:border-gray-800">{security?.privilegedMfaMode === 'enforce' && security.privileged ? <p className="text-sm text-amber-800 dark:text-amber-300">{t('stepUp.disableProtected')}</p> : <><p className="text-sm text-gray-500 dark:text-gray-400">{t('twoFactor.disableHint')}</p><button type="button" onClick={() => setChallenge('disable')} disabled={busy} className="min-h-11 rounded-md border border-red-300 px-4 text-sm text-red-700 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950">{t('twoFactor.disable')}</button></>}</div>
    </div>}
    {backupCodes && <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
      <h3 className="font-medium">{t('twoFactor.backupTitle')}</h3>
      <p className="text-sm">{t('twoFactor.backupWarning')}</p>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm">{backupCodes.map((value) => <code key={value}>{value}</code>)}</div>
      <button type="button" onClick={() => setBackupCodes(null)} className={button}>{t('twoFactor.saved')}</button>
    </div>}
    {challenge && <StepUpDialog purpose="two-factor" title={t(challenge === 'disable' ? 'twoFactor.disable' : 'twoFactor.regenerate')} onCancel={() => setChallenge(null)} onAuthorized={completeChallenge} />}
  </section>;
}
