import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../stores/auth';
import { api, apiOrigin } from '../../lib/api';
import { signOut } from '../../lib/auth-client';
import { awaitOperation } from './operations';
import { OperationError } from '../../lib/operation-error';

export default function SambaPassword() {
  const user = useAuth(s => s.user);
  const [identity, setIdentity] = useState<{ accountName: string; domain: string } | null>(null);
  const [old, setOld] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [changed, setChanged] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void api.get('/samba/me').then(r => setIdentity(r.data.identity || null)).catch(() => {});
  }, []);
  if (!identity) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    if (next !== confirmation) { setMessage('两次新密码不一致'); return; }
    submitting.current = true;
    setBusy(true);
    setMessage('');
    try {
      // The current AD password is the proof for this operation. No second
      // password dialog or separate local-login credential is needed.
      const response = await fetch(`${apiOrigin}/api/samba/me/password`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), old_password: old, password: next }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.code) throw new OperationError(data.code);
        if (response.status === 401) await useAuth.getState().fetchMe();
        const messages: Record<number, string> = {
          400: '提交信息无效，请检查密码长度与公司密码策略。',
          401: '登录状态已失效，或动态验证码不正确，请核对后重试。',
          403: '无法修改密码，请检查账号状态与动态验证码设置。',
          429: '尝试次数过多，请稍后重试。',
        };
        throw new Error(messages[response.status] || '公司账号服务暂时不可用，请稍后重试。');
      }
      await awaitOperation(data, true);
      setOld(''); setNext(''); setConfirmation(''); setChanged(true);
      setMessage(user?.passwordSource === 'directory' ? '公司 AD 密码已修改，请使用新密码重新登录。' : '公司 AD 密码已修改，本地 Assay 登录密码保持不变。');
    } catch (error: any) {
      setMessage(error.response?.data?.code ? new OperationError(error.response.data.code).message : error.message || '修改失败，请核对当前密码与公司密码策略');
    } finally {
      setBusy(false); submitting.current = false;
    }
  };

  return <section aria-label="公司 AD 密码" className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
    <h2 className="font-semibold">公司 AD 密码</h2>
    <p className="text-sm text-gray-500">账号：{identity.accountName}。{user?.passwordSource === 'directory' ? '这是公司登录与文件共享使用的同一套密码，修改后请重新登录。' : '修改后用于公司文件共享；本地 Assay 登录密码独立保留。'}</p>
    {!changed && <form className="space-y-3" onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy} className="space-y-3">
        {([
          ['当前 AD 密码', old, setOld],
          ['新的 AD 密码', next, setNext],
          ['确认新的 AD 密码', confirmation, setConfirmation],
        ] as const).map(([label, value, setter]) => <label key={label} className="block text-sm">
          <span>{label}</span>
          <input className="mt-1 min-h-11 w-full rounded-md border border-gray-300 bg-transparent px-3" type="password" minLength={8} maxLength={512} required autoComplete={label === '当前 AD 密码' ? 'current-password' : 'new-password'} value={value} onChange={e => setter(e.target.value)} />
        </label>)}
        <button disabled={busy} className="min-h-11 rounded-md bg-brand-700 px-4 text-sm text-white disabled:opacity-60" type="submit">{busy ? '正在修改…' : '修改公司密码'}</button>
      </fieldset>
    </form>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {changed && user?.passwordSource === 'directory' && <button className="min-h-11 rounded-md bg-brand-700 px-4 text-sm text-white" onClick={async () => {
      const result = await signOut();
      if (result.error) { setMessage('密码已修改，退出登录失败，请稍后重试。'); return; }
      useAuth.getState().clear(); window.location.assign('/login');
    }}>重新登录</button>}
  </section>;
}
