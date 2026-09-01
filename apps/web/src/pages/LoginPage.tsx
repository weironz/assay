import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authClient, signIn } from '../lib/auth-client';
import BrandMark from '../components/BrandMark';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { useAuth } from '../stores/auth';
import { type Msg, useMsg } from '../lib/messages';

type Tab = 'login' | 'register';

const inputCls =
  'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';

export default function LoginPage() {
  const { t } = useTranslation();
  const msg = useMsg();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fetchMe = useAuth((s) => s.fetchMe);

  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<Msg>(null);
  const [info, setInfo] = useState<Msg>(
    params.get('verified') ? { key: 'auth.verifiedInfo' } : null,
  );
  const [needVerify, setNeedVerify] = useState(false);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setError(null);
    setInfo(null);
    setNeedVerify(false);
  };

  const doLogin = async (e: FormEvent) => {
    e.preventDefault();
    reset();
    setLoading(true);
    try {
      const res = await signIn.email({ email, password, rememberMe: remember });
      if (res.error) {
        const code = (res.error as any).code;
        if (res.error.status === 429) {
          setError({ key: 'auth.errTooManyLogin' });
        } else if (code === 'EMAIL_NOT_VERIFIED') {
          setError({ key: 'auth.errEmailNotVerified' });
          setNeedVerify(true);
        } else {
          setError({ key: 'auth.errInvalidCredentials' });
        }
        return;
      }
      const me = await fetchMe();
      if (me) navigate('/dashboard', { replace: true });
      else setError({ key: 'auth.errSessionFailed' });
    } catch (err: any) {
      setError(
        err?.message ? { raw: err.message } : { key: 'auth.errLoginFailed' },
      );
    } finally {
      setLoading(false);
    }
  };

  const doRegister = async (e: FormEvent) => {
    e.preventDefault();
    reset();
    if (password.length < 6)
      return setError({ key: 'auth.errPasswordTooShort' });
    if (password !== confirm)
      return setError({ key: 'auth.errPasswordMismatch' });
    setLoading(true);
    try {
      const res = await authClient.signUp.email({
        email,
        password,
        name: name.trim() || email.split('@')[0],
        callbackURL: `${window.location.origin}/login?verified=1`,
      });
      if (res.error) {
        if (res.error.status === 429) {
          setError({ key: 'auth.errTooManyRegister' });
        } else if ((res.error as any).code === 'USER_ALREADY_EXISTS') {
          setError({ key: 'auth.errUserExists' });
        } else {
          setError(
            res.error.message
              ? { raw: res.error.message }
              : { key: 'auth.errRegisterFailed' },
          );
        }
        return;
      }
      // 已开启邮箱验证：注册后不会自动登录
      if (res.data && (res.data as any).token) {
        await fetchMe();
        navigate('/dashboard', { replace: true });
      } else {
        setTab('login');
        setPassword('');
        setConfirm('');
        setInfo({ key: 'auth.verificationSent', params: { email } });
      }
    } catch (err: any) {
      setError(
        err?.message ? { raw: err.message } : { key: 'auth.errRegisterFailed' },
      );
    } finally {
      setLoading(false);
    }
  };

  const resendVerify = async () => {
    setLoading(true);
    try {
      await authClient.sendVerificationEmail({
        email,
        callbackURL: `${window.location.origin}/login?verified=1`,
      });
      setError(null);
      setNeedVerify(false);
      setInfo({ key: 'auth.verificationResent', params: { email } });
    } catch {
      setError({ key: 'auth.errSendFailed' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      {/* 语言切换器：与找回/重置密码页保持同一位置 */}
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-9 flex justify-center">
          <BrandMark variant="stack" />
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 overflow-hidden">
          {/* 登录 / 注册 切换 */}
          <div className="grid grid-cols-2 text-sm border-b border-gray-200 dark:border-gray-800">
            {(['login', 'register'] as Tab[]).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => {
                  setTab(tabKey);
                  reset();
                }}
                className={`py-3 font-medium transition ${
                  tab === tabKey
                    ? 'text-brand-700 border-b-2 border-brand-600'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {tabKey === 'login' ? t('auth.tabLogin') : t('auth.tabRegister')}
              </button>
            ))}
          </div>

          <form
            onSubmit={tab === 'login' ? doLogin : doRegister}
            className="p-6 space-y-4"
          >
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                {t('auth.email')}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className={inputCls}
              />
            </div>

            {tab === 'register' && (
              <div>
                <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                  {t('auth.name')}
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('auth.namePlaceholder')}
                  className={inputCls}
                />
              </div>
            )}

            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                {t('auth.password')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={
                  tab === 'login' ? 'current-password' : 'new-password'
                }
                className={inputCls}
              />
            </div>

            {tab === 'register' && (
              <div>
                <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                  {t('auth.confirmPassword')}
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  className={inputCls}
                />
              </div>
            )}

            {tab === 'login' && (
              <div className="flex items-center justify-between text-sm">
                <label className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  {t('auth.rememberMe')}
                </label>
                <Link
                  to="/forgot-password"
                  className="text-brand-700 hover:underline"
                >
                  {t('auth.forgotPassword')}
                </Link>
              </div>
            )}

            {error && <p className="text-sm text-red-500">{msg(error)}</p>}
            {info && <p className="text-sm text-green-600">{msg(info)}</p>}
            {needVerify && (
              <button
                type="button"
                onClick={resendVerify}
                className="text-sm text-brand-700 hover:underline"
              >
                {t('auth.resendVerification')}
              </button>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-brand-700 text-white py-2 text-sm font-medium hover:bg-brand-800 disabled:opacity-60"
            >
              {loading
                ? t('common.processing')
                : tab === 'login'
                  ? t('auth.submitLogin')
                  : t('auth.submitRegister')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
