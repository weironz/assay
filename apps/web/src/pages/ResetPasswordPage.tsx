import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authClient } from '../lib/auth-client';
import BrandMark from '../components/BrandMark';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { type Msg, useMsg } from '../lib/messages';

export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const msg = useMsg();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<Msg>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6)
      return setError({ key: 'auth.errPasswordTooShort' });
    if (password !== confirm)
      return setError({ key: 'auth.errPasswordMismatch' });
    setLoading(true);
    try {
      const res = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (res.error) {
        setError(
          res.error.message?.includes('token')
            ? { key: 'reset.errInvalidToken' }
            : res.error.message
              ? { raw: res.error.message }
              : { key: 'reset.errFailed' },
        );
        return;
      }
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err: any) {
      setError(err?.message ? { raw: err.message } : { key: 'reset.errFailed' });
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';

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
          {t('reset.title')}
        </h2>
        <form
          onSubmit={submit}
          className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6 space-y-4"
        >
          {!token ? (
            <p className="text-sm text-red-500">{t('reset.missingToken')}</p>
          ) : done ? (
            <p className="text-sm text-green-600">{t('reset.done')}</p>
          ) : (
            <>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('reset.newPassword')}
                autoComplete="new-password"
                className={inputCls}
              />
              <input
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t('reset.confirmPassword')}
                autoComplete="new-password"
                className={inputCls}
              />
              {error && <p className="text-sm text-red-500">{msg(error)}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-brand-700 text-white py-2 text-sm font-medium hover:bg-brand-800 disabled:opacity-60"
              >
                {loading ? t('common.submitting') : t('reset.submit')}
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
