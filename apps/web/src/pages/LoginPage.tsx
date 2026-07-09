import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn } from '../lib/auth-client';
import { useAuth } from '../stores/auth';

export default function LoginPage() {
  const navigate = useNavigate();
  const fetchMe = useAuth((s) => s.fetchMe);
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('admin12345');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message || '登录失败');
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            工单管理系统
          </h1>
          <p className="text-sm text-gray-500 mt-1">Assay Ticket System</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6 space-y-4"
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
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-blue-600 text-white py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
          >
            {loading ? '登录中…' : '登录'}
          </button>
          <p className="text-xs text-gray-400 text-center">
            默认管理员：admin@example.com / admin12345
          </p>
        </form>
      </div>
    </div>
  );
}
