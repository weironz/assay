import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authClient } from '../lib/auth-client';
import BrandMark from '../components/BrandMark';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { type Msg, useMsg } from '../lib/messages';

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const msg = useMsg();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<Msg>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (res.error) {
        setError(
          res.error.status === 429
            ? { key: 'forgot.errTooMany' }
            : res.error.message
              ? { raw: res.error.message }
              : { key: 'forgot.errFailed' },
        );
        return;
      }
      setSent(true);
    } catch (err: any) {
      setError(
        err?.message ? { raw: err.message } : { key: 'forgot.errFailed' },
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandMark variant="stack" />
        </div>
        <h2 className="mb-4 text-center text-base font-medium text-gray-800 dark:text-gray-200">
          {t('forgot.title')}
        </h2>
        <form
          onSubmit={submit}
          className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6 space-y-4"
        >
          {sent ? (
            <>
              <p className="text-sm text-green-600">
                {t('forgot.sent', { email })}
              </p>
              <p className="text-xs text-gray-400">{t('forgot.hint')}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500">{t('forgot.intro')}</p>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('forgot.emailPlaceholder')}
                className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              />
              {error && <p className="text-sm text-red-500">{msg(error)}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-brand-700 text-white py-2 text-sm font-medium hover:bg-brand-800 disabled:opacity-60"
              >
                {loading ? t('forgot.sending') : t('forgot.send')}
              </button>
            </>
          )}
          <div className="text-center">
            <Link to="/login" className="text-sm text-brand-700 hover:underline">
              {t('forgot.backToLogin')}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
