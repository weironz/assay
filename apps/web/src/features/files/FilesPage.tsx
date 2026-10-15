import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, apiOrigin } from '../../lib/api';
import { Badge, DataTable, EditorDialog, button, card, input, link, primary } from '../samba/components';
import { displayDomain, type Editor } from '../samba/types';

interface Status { connected: boolean; identity: { accountName: string; domain: string } | null; shares?: string[]; expiresAt?: number; maxFileBytes?: number }
interface Entry { name: string; directory: boolean; size: number; modified: number; blocked: boolean }
const join = (path: string, name: string) => path ? `${path}/${name}` : name;
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export default function FilesPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState('');
  const [share, setShare] = useState('');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const browseAbort = useRef<AbortController | null>(null);
  const fail = useCallback((e: any) => {
    const message = e.response?.data?.message || '请求未完成，请刷新核对文件状态后再试。';
    setError(typeof message === 'string' ? message : '文件请求失败');
    if (e.response?.status === 410) { setStatus(s => s ? { ...s, connected: false } : s); setEntries([]); setPassword(''); }
  }, []);
  const refreshStatus = useCallback(async () => {
    try {
      const { data } = await api.get<Status>('/files/status'); setStatus(data);
      setShare(s => data.shares?.includes(s) ? s : data.shares?.[0] || '');
    } catch (e) { fail(e); }
  }, [fail]);
  const refresh = useCallback(async () => {
    browseAbort.current?.abort();
    if (!status?.connected || !share) { setEntries([]); return; }
    const controller = new AbortController(); browseAbort.current = controller;
    setLoading(true); setEntries([]);
    try { const { data } = await api.get('/files/list', { params: { share, path }, signal: controller.signal }); if (!controller.signal.aborted) setEntries(data.entries.sort((a: Entry, b: Entry) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))); }
    catch (e) { if (!controller.signal.aborted) { setEntries([]); fail(e); } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [status?.connected, share, path, fail]);
  useEffect(() => { void refreshStatus(); return () => uploadAbort.current?.abort(); }, [refreshStatus]);
  useEffect(() => { void refresh(); return () => browseAbort.current?.abort(); }, [refresh]);
  useEffect(() => {
    if (!status?.connected || !status.expiresAt) return;
    const timer = setTimeout(() => { setStatus(s => s ? { ...s, connected: false } : s); setEntries([]); setError('文件会话已到期，请重新验证 AD 密码。'); }, Math.max(0, status.expiresAt * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [status?.connected, status?.expiresAt]);
  const verify = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try { const { data } = await api.post<Status>('/files/session', { password }); setStatus(data); setShare(data.shares?.[0] || ''); setPath(''); }
    catch (e) { fail(e); }
    finally { setPassword(''); setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError(''); uploadAbort.current?.abort();
    try { await api.delete('/files/session'); setStatus(s => s ? { ...s, connected: false } : s); setEntries([]); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const upload = async (file?: File) => {
    if (!file) return;
    if (file.size > (status?.maxFileBytes || 0)) { setError('文件超过上传大小限制。'); return; }
    setBusy(true); setError(''); setNotice(''); setProgress(0);
    const controller = new AbortController(); uploadAbort.current = controller;
    try {
      await api.put('/files/content', file, { params: { share, path: join(path, file.name) }, headers: { 'Content-Type': 'application/octet-stream' }, signal: controller.signal,
        onUploadProgress: event => setProgress(event.total ? Math.round(event.loaded * 100 / event.total) : 0) });
      setNotice(`已上传 ${file.name}`);
    } catch (e) { if (controller.signal.aborted) setError('上传已取消，临时文件将清理。请刷新确认后再试。'); else fail(e); }
    finally { setProgress(null); setBusy(false); uploadAbort.current = null; if (uploadRef.current) uploadRef.current.value = ''; await refresh(); }
  };
  const openCommand = (action: string, entry?: Entry) => {
    setEditor({ action, title: action === 'mkdir' ? '新建文件夹' : action === 'move' ? '移动或重命名' : '删除文件或空文件夹',
      description: action === 'delete' ? `确认删除“${entry?.name}”？此操作不会递归删除非空文件夹。` : action === 'move' ? '填写当前共享目录内的目标路径。目标已存在时不会覆盖。' : '在当前目录创建文件夹。',
      values: { path: entry ? join(path, entry.name) : '', destination: entry ? join(path, entry.name) : '' },
      fields: action === 'delete' ? [] : [{ name: 'destination', label: action === 'mkdir' ? '文件夹名称' : '目标路径', maxLength: action === 'mkdir' ? 255 : 4096 }],
    });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!editor || busy) return;
    const c = editor; setBusy(true); setError(''); setNotice('');
    try {
      const destination = String(c.values.destination || '');
      if (c.action === 'mkdir' && destination.includes('/')) { setError('文件夹名称不能包含路径分隔符。'); return; }
      await api.post('/files/commands', { action: c.action, share, path: c.action === 'mkdir' ? join(path, destination) : c.values.path, ...(c.action === 'move' ? { destination } : {}) });
      setEditor(null); setNotice('操作已完成'); await refresh();
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-[1500px] space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">我的文件</h1><p className="mt-2 text-sm text-gray-500">使用本人的公司 AD 账号访问文件，由 Samba 校验共享权限和文件权限。</p></div>
      {status?.identity && <div className="flex flex-wrap items-center gap-3"><Badge>{displayDomain(status.identity.domain)} / {status.identity.accountName}</Badge>{status.connected && <button className={button} onClick={disconnect} disabled={busy}>断开文件会话</button>}</div>}
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
    {notice && <p role="status" className="text-sm text-green-700 dark:text-green-300">{notice}</p>}
    {!status ? <p className="text-sm text-gray-500">{error ? '文件模块暂不可用。' : '正在检查文件会话…'}</p> : !status.identity ?
      <section className={card + ' p-6'}><h2 className="font-semibold">尚未关联公司账号</h2><p className="mt-2 text-sm text-gray-500">请联系管理员，在“公司目录与文件 → 登录账号关联”中关联你的 AD 员工账号。</p></section> : !status.connected ?
      <form onSubmit={verify} className={card + ' max-w-lg space-y-4 p-6'}><h2 className="font-semibold">验证自己的 AD 密码</h2><p className="text-sm text-gray-500">首次访问、会话到期或连接失效后需要重新验证。AD 密码不写入 Assay 数据库或日志。</p>
        <label className="block space-y-2 text-sm"><span>AD 密码</span><input className={input} type="password" autoComplete="current-password" value={password} maxLength={512} onChange={e => setPassword(e.target.value)} required disabled={busy}/></label>
        <button className={primary} disabled={busy}>{busy ? '正在验证…' : '验证并打开文件'}</button>
      </form> : <>
        <div className={card + ' flex flex-wrap items-center justify-between gap-3 p-4'}>
          <label className="flex min-w-0 flex-wrap items-center gap-3 text-sm"><span>共享目录</span><select aria-label="共享目录" className={input + ' max-w-xs'} value={share} disabled={busy} onChange={e => { setShare(e.target.value); setPath(''); setError(''); }}>{status.shares?.map(s => <option key={s}>{s}</option>)}</select></label>
          <p className="text-xs text-gray-500">单文件上限 {size(status.maxFileBytes || 0)} · 最晚 {status.expiresAt ? new Date(status.expiresAt * 1000).toLocaleTimeString() : ''} 重新验证</p>
        </div>
        {!share ? <p className="text-sm text-gray-500">当前账号没有可访问的共享目录，请联系管理员核对用户组和权限。</p> : <>
          <nav aria-label="文件路径" className="flex flex-wrap items-center gap-2 break-all text-sm"><button disabled={busy} className={link} onClick={() => setPath('')}>{share}</button>{path.split('/').filter(Boolean).map((p, i, parts) => <span key={i}> / <button className={link} disabled={busy} onClick={() => setPath(parts.slice(0, i + 1).join('/'))}>{p}</button></span>)}</nav>
          {progress !== null && <div role="status" className="flex items-center gap-3 text-sm"><span>正在上传 {progress}%{progress === 100 ? '，等待服务器完成…' : ''}</span><button className={button} onClick={() => uploadAbort.current?.abort()}>取消上传</button></div>}
          <DataTable label="文件" rows={entries} rowKey={e => e.name} searchText={e => e.name} empty={loading ? '正在加载…' : '此文件夹为空'} actions={<><button className={button} disabled={busy || loading} onClick={() => { setError(''); void refresh(); }}>刷新</button><button className={button} disabled={busy} onClick={() => openCommand('mkdir')}>新建文件夹</button><button className={primary} disabled={busy} onClick={() => uploadRef.current?.click()}>上传文件</button><input ref={uploadRef} className="hidden" type="file" aria-label="选择上传文件" onChange={e => void upload(e.target.files?.[0])}/></>} columns={[
            { label: '名称', render: e => <button className={link + ' break-all text-left'} disabled={busy || e.blocked || !e.directory} onClick={() => { setPath(join(path, e.name)); setError(''); }}>{e.directory ? '▣ ' : '▤ '}{e.name}{e.blocked ? '（不支持访问）' : ''}</button> },
            { label: '大小', render: e => e.directory ? '—' : size(e.size) },
            { label: '修改时间', render: e => new Date(e.modified * 1000).toLocaleString() },
            { label: '操作', render: e => <div className="flex flex-wrap gap-3 whitespace-nowrap">{!e.directory && !e.blocked && <a className={link} href={`${apiOrigin}/api/files/content?${new URLSearchParams({ share, path: join(path, e.name) })}`} onClick={event => { if (busy) event.preventDefault(); }}>下载</a>}<button className={link} disabled={busy || e.blocked} onClick={() => openCommand('move', e)}>移动 / 重命名</button><button className="text-red-600 disabled:opacity-50" disabled={busy || e.blocked} onClick={() => openCommand('delete', e)}>删除</button></div> },
          ]}/>
        </>}
      </>}
    {editor && <EditorDialog editor={editor} busy={busy} submitLabel="确认操作" setEditor={setEditor} submit={submit} cancel={() => { if (!busy) setEditor(null); }}/>}
  </div>;
}
