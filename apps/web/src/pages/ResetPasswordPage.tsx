import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authClient } from '../lib/auth-client';
import BrandMark from '../components/BrandMark';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) return setError('密码至少 6 位');
    if (password !== confirm) return setError('两次输入的密码不一致');
    setLoading(true);
    try {
      const res = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (res.error) {
        setError(
          res.error.message?.includes('token')
            ? '链接无效或已过期，请重新申请找回密码'
            : res.error.message || '重置失败',
        );
        return;
      }
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err: any) {
      setError(err?.message || '重置失败');
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandMark variant="stack" />
        </div>
        <h2 className="mb-4 text-center text-base font-medium text-gray-800 dark:text-gray-200">
          设置新密码
        </h2>
        <form
          onSubmit={submit}
          className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6 space-y-4"
        >
          {!token ? (
            <p className="text-sm text-red-500">
              缺少重置令牌，请从邮件中的链接进入。
            </p>
          ) : done ? (
            <p className="text-sm text-green-600">
              ✓ 密码已重置，正在跳转到登录页…
            </p>
          ) : (
            <>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="新密码（≥6 位）"
                autoComplete="new-password"
                className={inputCls}
              />
              <input
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="确认新密码"
                autoComplete="new-password"
                className={inputCls}
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-brand-700 text-white py-2 text-sm font-medium hover:bg-brand-800 disabled:opacity-60"
              >
                {loading ? '提交中…' : '确认重置'}
              </button>
            </>
          )}
          <div className="text-center">
            <Link to="/login" className="text-sm text-brand-700 hover:underline">
              返回登录
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
