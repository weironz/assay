import { awaitOperation } from './operations';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import StepUpDialog from '../../components/StepUpDialog';
import { stepUpHeaders } from '../../lib/security-step-up';

type User = { id: string; name: string; displayName: string; disabled: boolean; dn: string; sid: string };
type Group = { id: string; name: string; description: string; members: string[]; sid: string };
type Share = { name: string; comment: string; groups: string[]; read_only: boolean; active: boolean };
type Snapshot = { enabled: boolean; readOnly: boolean; domain: string; users: User[]; groups: Group[]; shares: Share[]; bindings: { userId: string; adObjectId: string; accountName: string }[]; assayUsers: { id: string; name: string; email: string }[] };
type Acl = { revision: string; protected: boolean; owner: string; entries: { sid?: string; effect: string; mask?: number; inherited: boolean; inherit?: boolean; details?: string }[] };
type Field = { name: string; label: string; type?: 'password' | 'checkbox' | 'select' | 'multi'; options?: { value: string; label: string }[] };
type Editor = { title: string; action: string; fields: Field[]; values: Record<string, any>; endpoint?: string };
type Pending = { title: string; endpoint: string; body: unknown };
const input = 'min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800';
const button = 'min-h-10 rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800';
const primary = button + ' bg-brand-700 text-white hover:bg-brand-800';
const card = 'rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900';
function errorMessage(e: any) { return e.response?.data?.message || e.message || '请求失败，请检查连接与操作记录'; }
export default function SambaPage() {
  const { has } = useAuth();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState('users');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [selectedShare, setSelectedShare] = useState('');
  const [path, setPath] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [acl, setAcl] = useState<Acl | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const directoryRequest = useRef(0);
  const canWrite = has('samba:manage') && !snapshot?.readOnly && !busy;
  async function load() {
    setBusy(true);
    try { setSnapshot((await api.get('/samba/snapshot')).data); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function loadDirectory(share = selectedShare, p = path) {
    if (!share) return;
    const request = ++directoryRequest.current;
    setAcl(null); setDirectories([]);
    try {
      const q = new URLSearchParams({ share, path: p });
      const [d, a] = await Promise.all([api.get(`/samba/directories?${q}`), api.get(`/samba/acl?${q}`)]);
      if (request !== directoryRequest.current) return;
      setDirectories(d.data.directories); setAcl(a.data);
    } catch (e) { if (request === directoryRequest.current) setError(errorMessage(e)); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { void loadDirectory(); }, [selectedShare, path]);
  useEffect(() => { if (tab === 'history') void api.get('/samba/operations').then(r => setHistory(r.data)).catch(e => setError(errorMessage(e))); }, [tab, notice]);
  const users = snapshot?.users || [];
  const groups = snapshot?.groups || [];
  const groupOptions = groups.map(g => ({ value: g.id, label: g.name }));
  const userOptions = users.map(u => ({ value: u.id, label: `${u.name} · ${u.displayName}` }));
  const principalName = (sid?: string) => groups.find(g => g.sid === sid)?.name || users.find(u => u.sid === sid)?.name || sid || '高级权限条目';
  const open = (e: Editor) => { setError(''); setNotice(''); setEditor(e); };
  const confirm = (title: string, action: string, args: unknown) => { setError(''); setNotice(''); setPending({ title, endpoint: '/samba/commands', body: { requestId: crypto.randomUUID(), action, args } }); };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!editor) return;
    setPending({ title: editor.title, endpoint: editor.endpoint || '/samba/commands', body: editor.endpoint ? editor.values : { requestId: crypto.randomUUID(), action: editor.action, args: editor.values } });
    setEditor(null);
  };
  const complete = async (token: string) => {
    if (!pending) return;
    try {
      const response = await api.post(pending.endpoint, pending.body, { headers: stepUpHeaders(token) });
      if (pending.endpoint.endsWith('/commands')) await awaitOperation(response.data);
      setNotice('操作已完成'); setError(''); await load();
      const operation = pending.body as { action?: string; args?: { path?: string } };
      const nextPath = operation.action === 'directory.delete' ? (operation.args?.path || '').split('/').slice(0, -1).join('/') : path;
      if (operation.action === 'directory.delete') setPath(nextPath);
      if (selectedShare) await loadDirectory(selectedShare, nextPath);
    } catch (e) { setError(errorMessage(e)); throw e; }
  };
  const table = (headers: string[], rows: React.ReactNode[][]) => <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{headers.map(h => <th key={h} className="border-b p-3">{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border-b border-gray-100 p-3 align-top dark:border-gray-800">{c}</td>)}</tr>)}</tbody></table>{!rows.length && <p className="p-4 text-gray-500">暂无记录</p>}</div>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">公司账号与文件共享</h1><p className="mt-1 text-sm text-gray-500">统一管理员工 AD 账号、用户组和文件访问权限</p></div><button className={button} disabled={busy} onClick={() => { setError(''); void load(); }}>刷新</button></div>
    {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-md bg-green-50 p-3 text-green-800">{notice}</p>}
    {snapshot?.enabled === false && <div className={card}>尚未配置公司目录连接，请联系部署管理员。</div>}
    {snapshot?.enabled && <>
      <div className="text-sm text-gray-500">成员、账号状态或共享权限变更后，请重新连接文件共享以刷新访问权限。<br />目录：{snapshot.domain} · {users.length} 个员工账号 · {groups.length} 个用户组 · {snapshot.shares.filter(s => s.active).length} 个受管共享 {snapshot.readOnly && '· 当前为只读模式'}</div>
      <div role="tablist" aria-label="公司目录管理" className="flex flex-wrap gap-2">{[['users', '员工账号'], ['groups', '用户组'], ['shares', '共享与目录'], ['bindings', '身份绑定'], ['history', '操作记录']].map(([key, label]) => <button role="tab" aria-selected={tab === key} key={key} className={tab === key ? primary : button} onClick={() => setTab(key)}>{label}</button>)}</div>
      <section className={card}>
        {tab === 'users' && <><button className={primary} disabled={!canWrite} onClick={() => open({ title: '新增员工账号', action: 'user.create', fields: [{ name: 'name', label: '登录账号' }, { name: 'display_name', label: '员工姓名' }, { name: 'password', label: '初始 AD 密码', type: 'password' }], values: { name: '', display_name: '', password: '' } })}>新增员工</button>
          {table(['登录账号', '员工姓名', '状态', '操作'], users.map(u => [u.name, u.displayName, u.disabled ? '已停用' : '已启用', <div className="flex flex-wrap gap-2"><button className={button} disabled={!canWrite} onClick={() => open({ title: '编辑员工账号', action: 'user.update', fields: [{ name: 'display_name', label: '员工姓名' }, { name: 'disabled', label: '停用账号', type: 'checkbox' }], values: { id: u.id, display_name: u.displayName || u.name, disabled: u.disabled } })}>编辑</button><button className={button} disabled={!canWrite} onClick={() => open({ title: '重置 AD 密码', action: 'user.password', fields: [{ name: 'password', label: '新的 AD 密码', type: 'password' }], values: { id: u.id, password: '' } })}>重置密码</button></div>]))}</>}
        {tab === 'groups' && <><button className={primary} disabled={!canWrite} onClick={() => open({ title: '新增用户组', action: 'group.create', fields: [{ name: 'name', label: '用户组名称' }, { name: 'description', label: '说明' }], values: { name: '', description: '' } })}>新增用户组</button>
          {table(['用户组', '说明', '成员', '操作'], groups.map(g => [g.name, g.description, <ul>{g.members.map(dn => <li key={dn}>{users.find(u => u.dn === dn)?.name || dn}</li>)}</ul>, <div className="flex flex-wrap gap-2"><button className={button} disabled={!canWrite} onClick={() => open({ title: '编辑用户组', action: 'group.update', fields: [{ name: 'description', label: '说明' }], values: { id: g.id, description: g.description } })}>编辑</button><button className={button} disabled={!canWrite || !users.length} onClick={() => open({ title: '调整组成员', action: 'group.member', fields: [{ name: 'user_id', label: '员工账号', type: 'select', options: userOptions }, { name: 'add', label: '加入用户组（取消勾选表示移出）', type: 'checkbox' }], values: { group_id: g.id, user_id: users[0]?.id || '', add: true } })}>调整成员</button><button className={button} disabled={!canWrite || g.members.length > 0} onClick={() => confirm('删除空用户组', 'group.delete', { id: g.id })}>删除</button></div>]))}</>}
        {tab === 'shares' && <div className="space-y-5"><button className={primary} disabled={!canWrite} onClick={() => open({ title: '新增共享', action: 'share.save', fields: [{ name: 'name', label: '共享名称' }, { name: 'comment', label: '说明' }, { name: 'groups', label: '允许访问的用户组', type: 'multi', options: groupOptions }, { name: 'read_only', label: '共享只读', type: 'checkbox' }], values: { name: '', comment: '', groups: [], read_only: false } })}>新增共享</button>
          {table(['共享名称', '说明', '允许访问的组', '操作'], snapshot.shares.filter(s => s.active).map(s => [s.name, s.comment, s.groups.join('、'), <div className="flex flex-wrap gap-2"><button className={button} onClick={() => { setSelectedShare(s.name); setPath(''); }}>管理目录与权限</button><button className={button} disabled={!canWrite} onClick={() => open({ title: '编辑共享', action: 'share.save', fields: [{ name: 'comment', label: '说明' }, { name: 'groups', label: '允许访问的用户组', type: 'multi', options: groupOptions }, { name: 'read_only', label: '共享只读', type: 'checkbox' }], values: { name: s.name, comment: s.comment, read_only: s.read_only, groups: groups.filter(g => s.groups.includes(g.name)).map(g => g.id) } })}>编辑</button><button className={button} disabled={!canWrite} onClick={() => { if (selectedShare === s.name) setSelectedShare(''); confirm('移除共享（保留目录和文件）', 'share.remove', { name: s.name }); }}>移除共享</button></div>]))}
          {snapshot.shares.some(s => !s.active) && <details><summary>已移除的共享（文件保留）</summary>{snapshot.shares.filter(s => !s.active).map(s => <div className="mt-3 flex items-center gap-3" key={s.name}><span>{s.name}</span><button className={button} disabled={!canWrite} onClick={() => open({ title: '恢复共享', action: 'share.save', fields: [{ name: 'comment', label: '说明' }, { name: 'groups', label: '允许访问的用户组', type: 'multi', options: groupOptions }, { name: 'read_only', label: '共享只读', type: 'checkbox' }], values: { name: s.name, comment: s.comment, read_only: s.read_only, groups: groups.filter(g => s.groups.includes(g.name)).map(g => g.id) } })}>恢复共享</button></div>)}</details>}
          {selectedShare && <div className="space-y-4 border-t pt-4"><h2 className="font-semibold">目录与权限：{selectedShare}/{path}</h2><div className="flex flex-wrap gap-2"><button className={button} onClick={() => setPath('')}>共享根目录</button>{path && <button className={button} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>上级目录</button>}<button className={button} onClick={() => void loadDirectory()}>刷新目录</button><button className={button} disabled={!canWrite} onClick={() => open({ title: '新建目录', action: 'directory.create', fields: [{ name: 'path', label: '相对共享根目录的路径' }], values: { share: selectedShare, path: path ? path + '/' : '' } })}>新建目录</button>{path && <button className={button} disabled={!canWrite} onClick={() => confirm('删除空目录', 'directory.delete', { share: selectedShare, path })}>删除当前空目录</button>}</div>
            <div className="flex flex-wrap gap-2">{directories.map(d => <button className={button} key={d} onClick={() => setPath(path ? path + '/' + d : d)}>📁 {d}</button>)}</div>
            {acl && <><h3 className="font-medium">Windows 目录权限</h3><p className="text-sm text-gray-500">继承条目来自上级目录；移除直接授权后，其他组或继承权限仍可能生效。</p>
              {table(['账号或组', '类型', '权限', '继承'], acl.entries.map(a => [principalName(a.sid), a.effect === 'allow' ? '允许' : a.effect === 'deny' ? '拒绝' : '高级条目', a.mask === 0x1f01ff ? '完全控制' : a.mask === 0x1301bf ? '修改' : a.mask === 0x1200a9 ? '读取' : a.mask !== undefined ? `0x${a.mask.toString(16)}` : a.details, a.inherited ? '来自上级目录' : a.inherit ? '应用到子目录与文件' : '仅此目录']))}
              <button className={button} disabled={!canWrite || !groups.length} onClick={() => open({ title: '设置用户组目录权限', action: 'acl.grant', fields: [{ name: 'principal_id', label: '用户组', type: 'select', options: groupOptions }, { name: 'mode', label: '访问权限', type: 'select', options: [{ value: 'read', label: '读取' }, { value: 'modify', label: '修改（读写删除）' }, { value: 'full', label: '完全控制（含权限管理）' }, { value: 'remove', label: '移除直接授权' }] }, { name: 'inherit', label: '应用到子目录与文件', type: 'checkbox' }], values: { share: selectedShare, path, principal_id: groups[0]?.id, group: true, mode: 'read', inherit: true, revision: acl.revision } })}>设置用户组权限</button>
              <button className={button + ' ml-2'} disabled={!canWrite || !users.length} onClick={() => open({ title: '设置员工目录权限', action: 'acl.grant', fields: [{ name: 'principal_id', label: '员工账号', type: 'select', options: userOptions }, { name: 'mode', label: '访问权限', type: 'select', options: [{ value: 'read', label: '读取' }, { value: 'modify', label: '修改（读写删除）' }, { value: 'remove', label: '移除直接授权' }] }, { name: 'inherit', label: '应用到子目录与文件', type: 'checkbox' }], values: { share: selectedShare, path, principal_id: users[0]?.id, group: false, mode: 'read', inherit: true, revision: acl.revision } })}>设置员工权限</button></>}
          </div>}
        </div>}
        {tab === 'bindings' && <><p className="mb-4 text-sm text-gray-500">绑定后，员工可以在个人设置中修改自己的 AD 密码。绑定不会修改 Assay 登录密码或业务角色。</p><button className={primary} disabled={!canWrite || !users.length} onClick={() => open({ title: '绑定员工 AD 身份', action: '', endpoint: '/samba/bindings', fields: [{ name: 'userId', label: 'Assay 用户', type: 'select', options: snapshot.assayUsers.map(u => ({ value: u.id, label: `${u.name} · ${u.email}` })) }, { name: 'adObjectId', label: 'AD 员工账号', type: 'select', options: userOptions }], values: { userId: snapshot.assayUsers[0]?.id || '', adObjectId: users[0]?.id || '' } })}>绑定身份</button>
          {table(['Assay 用户', 'AD 账号', '操作'], snapshot.bindings.map(b => [snapshot.assayUsers.find(u => u.id === b.userId)?.name || b.userId, b.accountName, <button className={button} disabled={!canWrite} onClick={() => setPending({ title: '解除 AD 身份绑定', endpoint: '/samba/bindings', body: { userId: b.userId, adObjectId: null } })}>解除绑定</button>]))}</>}
        {tab === 'history' && <>{table(['时间', '操作人', '操作', '状态', '详情'], history.map(h => [new Date(h.createdAt).toLocaleString(), h.actorName, h.action, ({ succeeded: '已完成', failed: '失败', uncertain: '结果待核对', pending: '执行中', queued: '排队中', running: '执行中' } as Record<string, string>)[h.state] || h.state, <details><summary>查看</summary><pre className="max-w-md overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ parameters: h.metadata, result: h.result }, null, 2)}</pre>{['pending', 'queued', 'running', 'uncertain'].includes(h.state) && <button className={button} onClick={async () => { await api.get(`/samba/operations/${h.id}`); setHistory((await api.get('/samba/operations')).data); }}>核对执行结果</button>}</details>]))}</>}
      </section>
    </>}
    {editor && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><section role="dialog" aria-modal="true" aria-label={editor.title} className={card + ' w-full max-w-lg max-h-[90vh] overflow-auto'}><h2 className="text-lg font-semibold">{editor.title}</h2><form onSubmit={submit} className="mt-4 space-y-4">{editor.fields.map(f => <label className="block space-y-1 text-sm" key={f.name}><span>{f.label}</span>{f.type === 'checkbox' ? <input className="ml-3" type="checkbox" checked={!!editor.values[f.name]} onChange={e => setEditor({ ...editor, values: { ...editor.values, [f.name]: e.target.checked } })} /> : f.type === 'select' || f.type === 'multi' ? <select aria-label={f.label} className={input} multiple={f.type === 'multi'} value={editor.values[f.name]} onChange={e => setEditor({ ...editor, values: { ...editor.values, [f.name]: f.type === 'multi' ? [...e.target.selectedOptions].map(o => o.value) : e.target.value } })}>{f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <input className={input} autoFocus={f === editor.fields[0]} type={f.type || 'text'} autoComplete={f.type === 'password' ? 'new-password' : 'off'} required maxLength={f.type === 'password' ? 512 : 1024} value={editor.values[f.name]} onChange={e => setEditor({ ...editor, values: { ...editor.values, [f.name]: e.target.value } })} />}</label>)}<div className="flex justify-end gap-2"><button type="button" className={button} onClick={() => setEditor(null)}>取消</button><button className={primary} type="submit">确认并验证身份</button></div></form></section></div>}
    {pending && <StepUpDialog purpose="samba" title={pending.title} onCancel={() => setPending(null)} onAuthorized={complete} />}
  </div>;
}
