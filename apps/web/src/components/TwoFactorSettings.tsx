import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'react-qr-code';
import { authClient } from '../lib/auth-client';
import { useAuth } from '../stores/auth';

const input = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800';
const button = 'rounded-md bg-brand-700 px-4 py-2 text-sm text-white hover:bg-brand-800 disabled:opacity-60';

type Setup = { uri: string; codes: string[] };

export default function TwoFactorSettings() {
  const { t } = useTranslation();
  const { user, fetchMe } = useAuth();
  const [password, setPassword] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await task(); }
    catch (err) { setError(err instanceof Error ? err.message : t('twoFactor.failed')); }
    finally { setBusy(false); }
  };

  const begin = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.twoFactor.enable({ password });
      if (result.error || !result.data) throw new Error(result.error?.message || t('twoFactor.failed'));
      setSetup({ uri: result.data.totpURI, codes: result.data.backupCodes });
      setPassword('');
    });
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (!setup) return;
    void run(async () => {
      const result = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (result.error) throw new Error(result.error.message || t('twoFactor.invalidCode'));
      setBackupCodes(setup.codes);
      setSetup(null); setCode('');
      await fetchMe();
      setNotice(t('twoFactor.enabled'));
    });
  };

  const disable = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.twoFactor.disable({ password: disablePassword });
      if (result.error) throw new Error(result.error.message || t('twoFactor.failed'));
      setPassword(''); setDisablePassword(''); setSetup(null); setBackupCodes(null);
      await fetchMe();
      setNotice(t('twoFactor.disabled'));
    });
  };

  const regenerate = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await authClient.twoFactor.generateBackupCodes({ password });
      if (result.error || !result.data) throw new Error(result.error?.message || t('twoFactor.failed'));
      setBackupCodes(result.data.backupCodes);
      setPassword('');
      setNotice(t('twoFactor.regenerated'));
    });
  };

  const secret = setup ? new URL(setup.uri).searchParams.get('secret') : null;

  return <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
    <div><h2 className="font-medium">{t('twoFactor.title')}</h2><p className="mt-1 text-sm text-gray-500">{t('twoFactor.intro')}</p></div>
    <p className={`text-sm font-medium ${user?.twoFactorEnabled ? 'text-green-700 dark:text-green-400' : 'text-gray-500'}`}>{t(user?.twoFactorEnabled ? 'twoFactor.statusOn' : 'twoFactor.statusOff')}</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
    {!user?.twoFactorEnabled && !setup && <form onSubmit={begin} className="space-y-3">
      <label className="block text-sm" htmlFor="two-factor-enable-password">{t('twoFactor.password')}</label>
      <input id="two-factor-enable-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
      <button disabled={busy} className={button}>{t('twoFactor.start')}</button>
    </form>}
    {setup && !user?.twoFactorEnabled && <div className="space-y-4">
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
    {user?.twoFactorEnabled && !backupCodes && <div className="space-y-4">
      <p className="text-xs text-gray-500">{t('twoFactor.apiTokenNotice')}</p>
      <form onSubmit={regenerate} className="space-y-3">
        <label className="block text-sm" htmlFor="two-factor-regenerate-password">{t('twoFactor.regenerateHint')}</label>
        <input id="two-factor-regenerate-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        <button disabled={busy} className={button}>{t('twoFactor.regenerate')}</button>
      </form>
      <form onSubmit={disable} className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
        <label className="block text-sm text-gray-500" htmlFor="two-factor-disable-password">{t('twoFactor.disableHint')}</label>
        <input id="two-factor-disable-password" type="password" required autoComplete="current-password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} className={input} />
        <button disabled={busy || !disablePassword} className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950">{t('twoFactor.disable')}</button>
      </form>
    </div>}
    {backupCodes && <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
      <h3 className="font-medium">{t('twoFactor.backupTitle')}</h3>
      <p className="text-sm">{t('twoFactor.backupWarning')}</p>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm">{backupCodes.map((value) => <code key={value}>{value}</code>)}</div>
      <button type="button" onClick={() => setBackupCodes(null)} className={button}>{t('twoFactor.saved')}</button>
    </div>}
  </section>;
}
