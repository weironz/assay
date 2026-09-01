import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { authClient } from '../lib/auth-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (res.error) {
        setError(
          res.error.status === 429
            ? '请求过于频繁，请稍后再试'
            : res.error.message || '发送失败',
        );
        return;
      }
      setSent(true);
    } catch (err: any) {
      setError(err?.message || '发送失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-center mb-8 text-gray-900 dark:text-gray-100">
          找回密码
        </h1>
        <form
          onSubmit={submit}
          className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6 space-y-4"
        >
          {sent ? (
            <>
              <p className="text-sm text-green-600">
                如果该邮箱已注册，重置链接已发送至 {email}，请查收邮件。
              </p>
              <p className="text-xs text-gray-400">
                没收到？请检查垃圾邮件，或稍后重试。链接 1 小时内有效。
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500">
                输入注册邮箱，我们会发送一封重置密码的邮件。
              </p>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="邮箱"
                className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-blue-600 text-white py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
              >
                {loading ? '发送中…' : '发送重置邮件'}
              </button>
            </>
          )}
          <div className="text-center">
            <Link to="/login" className="text-sm text-blue-600 hover:underline">
              返回登录
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
