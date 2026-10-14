import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { beginOidc, oidcAccount, oidcProvider, type OidcAccount, type OidcProvider } from '../lib/oidc';
import StepUpDialog from './StepUpDialog';

export default function OidcSettings() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [provider, setProvider] = useState<OidcProvider | null>(null);
  const [account, setAccount] = useState<OidcAccount | null>(null);
  const [challenge, setChallenge] = useState(false);
  useEffect(() => {
    let active = true;
    void oidcProvider().then(async provider => {
      if (active) setProvider(provider);
      if (provider.enabled) {
        const account = await oidcAccount();
        if (active) setAccount(account);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (!provider?.enabled || !account) return null;
  return <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
    <h2 className="font-medium">{t('auth.oidcAccountTitle')}</h2>
    <p className="text-sm text-gray-500">{t(account.linked ? 'auth.oidcLinked' : 'auth.oidcLinkHint', { provider: provider.name })}</p>
    {params.get('oidc_error') === '1' && <p role="alert" className="text-sm text-red-600">{t('auth.oidcFailed')}</p>}
    {!account.linked && account.canLink && <button type="button" onClick={() => setChallenge(true)} className="min-h-11 rounded-md border border-gray-300 px-4 text-sm dark:border-gray-700">{t('auth.oidcLink')}</button>}
    {!account.linked && !account.canLink && <p className="text-sm text-amber-600">{t('auth.oidcLinkUnavailable')}</p>}
    {challenge && <StepUpDialog purpose="account" title={t('auth.oidcLink')} onCancel={() => setChallenge(false)} onAuthorized={async token => {
      window.location.assign(await beginOidc(window.location.origin, token));
    }} />}
  </section>;
}
