import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authClient, signIn } from '../lib/auth-client';
import BrandMark from '../components/BrandMark';
import { useAuth } from '../stores/auth';

type Tab = 'login' | 'register';

const inputCls =
  'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fetchMe = useAuth((s) => s.fetchMe);

  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(
    params.get('verified') ? '邮箱验证成功，请登录。' : '',
  );
  const [needVerify, setNeedVerify] = useState(false);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setError('');
    setInfo('');
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
          setError('登录尝试过于频繁，请稍后再试');
        } else if (code === 'EMAIL_NOT_VERIFIED') {
          setError('邮箱尚未验证，请先完成邮箱验证');
          setNeedVerify(true);
        } else {
          setError('邮箱或密码错误');
        }
        return;
      }
      const me = await fetchMe();
      if (me) navigate('/dashboard', { replace: true });
      else setError('会话获取失败');
    } catch (err: any) {
      setError(err?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const doRegister = async (e: FormEvent) => {
    e.preventDefault();
    reset();
    if (password.length < 6) return setError('密码至少 6 位');
    if (password !== confirm) return setError('两次输入的密码不一致');
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
          setError('注册过于频繁，请稍后再试');
        } else if ((res.error as any).code === 'USER_ALREADY_EXISTS') {
          setError('该邮箱已注册，请直接登录或找回密码');
        } else {
          setError(res.error.message || '注册失败');
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
        setInfo(`验证邮件已发送至 ${email}，请查收并点击链接完成验证后登录。`);
      }
    } catch (err: any) {
      setError(err?.message || '注册失败');
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
      setError('');
      setNeedVerify(false);
      setInfo(`验证邮件已重新发送至 ${email}，请查收。`);
    } catch {
      setError('发送失败，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-9 flex justify-center">
          <BrandMark variant="stack" />
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 overflow-hidden">
          {/* 登录 / 注册 切换 */}
          <div className="grid grid-cols-2 text-sm border-b border-gray-200 dark:border-gray-800">
            {(['login', 'register'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTab(t);
                  reset();
                }}
                className={`py-3 font-medium transition ${
                  tab === t
                    ? 'text-brand-700 border-b-2 border-brand-600'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {t === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>

          <form
            onSubmit={tab === 'login' ? doLogin : doRegister}
            className="p-6 space-y-4"
          >
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                邮箱
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
                  姓名
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如何称呼你"
                  className={inputCls}
                />
              </div>
            )}

            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                密码
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
                  确认密码
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
                  记住我
                </label>
                <Link
                  to="/forgot-password"
                  className="text-brand-700 hover:underline"
                >
                  忘记密码？
                </Link>
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}
            {info && <p className="text-sm text-green-600">{info}</p>}
            {needVerify && (
              <button
                type="button"
                onClick={resendVerify}
                className="text-sm text-brand-700 hover:underline"
              >
                重新发送验证邮件
              </button>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-brand-700 text-white py-2 text-sm font-medium hover:bg-brand-800 disabled:opacity-60"
            >
              {loading
                ? '处理中…'
                : tab === 'login'
                  ? '登录'
                  : '注册账号'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
