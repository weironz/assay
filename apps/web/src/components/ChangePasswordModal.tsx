import { FormEvent, useState } from 'react';
import { authClient } from '../lib/auth-client';

export default function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    if (next.length < 6) return setMsg('新密码至少 6 位');
    if (next !== confirm) return setMsg('两次输入的新密码不一致');
    setLoading(true);
    try {
      const res = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: false,
      });
      if (res.error) {
        setMsg(res.error.message || '修改失败（原密码可能不正确）');
      } else {
        setOk(true);
        setMsg('密码修改成功');
      }
    } catch (err: any) {
      setMsg(err?.message || '修改失败');
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 space-y-3"
      >
        <h2 className="text-lg font-semibold">修改密码</h2>
        {ok ? (
          <>
            <p className="text-sm text-green-600">✓ 密码修改成功</p>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-md bg-blue-600 text-white py-2 text-sm hover:bg-blue-700"
            >
              关闭
            </button>
          </>
        ) : (
          <>
            <input
              type="password"
              placeholder="当前密码"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={inputCls}
            />
            <input
              type="password"
              placeholder="新密码（≥6 位）"
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={inputCls}
            />
            <input
              type="password"
              placeholder="确认新密码"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputCls}
            />
            {msg && <p className="text-sm text-red-500">{msg}</p>}
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 rounded-md bg-blue-600 text-white py-2 text-sm hover:bg-blue-700 disabled:opacity-60"
              >
                {loading ? '提交中…' : '确认修改'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm"
              >
                取消
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
