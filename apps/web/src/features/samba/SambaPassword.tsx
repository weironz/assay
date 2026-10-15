import { useAuth } from '../../stores/auth';
import { awaitOperation } from './operations';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import StepUpDialog from '../../components/StepUpDialog';
import { stepUpHeaders } from '../../lib/security-step-up';
export default function SambaPassword() {
  const passwordSource = useAuth(s => s.user?.passwordSource);
  const [identity, setIdentity] = useState<{ accountName: string; domain: string } | null>(null);
  const [old, setOld] = useState(''); const [next, setNext] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [challenge, setChallenge] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => { void api.get('/samba/me').then(r => setIdentity(r.data.identity || null)).catch(() => {}); }, []);
  if (!identity) return null;
  return <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900"><h2 className="font-semibold">公司 AD 密码</h2><p className="text-sm text-gray-500">账号：{identity.accountName}。{passwordSource === 'directory' ? '这是公司登录与文件共享使用的同一套密码，修改后请重新登录。' : '修改后用于公司文件共享；本地 Assay 登录密码独立保留。'}</p><form className="space-y-3" onSubmit={e => { e.preventDefault(); if (next !== confirmation) { setMessage('两次新密码不一致'); return; } setMessage(''); setChallenge(true); }}>
    {[['当前 AD 密码', old, setOld], ['新的 AD 密码', next, setNext], ['确认新的 AD 密码', confirmation, setConfirmation]].map(([label, value, setter]) => <label key={label as string} className="block text-sm"><span>{label as string}</span><input className="mt-1 min-h-11 w-full rounded-md border border-gray-300 bg-transparent px-3" type="password" minLength={8} required autoComplete={label === '当前 AD 密码' ? 'current-password' : 'new-password'} value={value as string} onChange={e => (setter as (v: string) => void)(e.target.value)} /></label>)}<button className="min-h-11 rounded-md bg-brand-700 px-4 text-sm text-white" type="submit">修改公司密码</button></form>
    {message && <p role="status" className="text-sm">{message}</p>}
    {challenge && <StepUpDialog purpose="account" title="修改公司 AD 密码" onCancel={() => setChallenge(false)} onAuthorized={async token => {
      try { const response = await api.post('/samba/me/password', { requestId: crypto.randomUUID(), old_password: old, password: next }, { headers: stepUpHeaders(token) }); await awaitOperation(response.data, true); setOld(''); setNext(''); setConfirmation(''); setMessage('公司 AD 密码已修改'); }
      catch (e: any) { setMessage(e.response?.data?.message || e.message || '修改失败，请核对旧密码与公司密码策略'); throw e; }
    }} />}
  </section>;
}
