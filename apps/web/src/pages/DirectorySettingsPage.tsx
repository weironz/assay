import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';
import StepUpDialog from '../components/StepUpDialog';
import { guardedApi } from '../lib/security-step-up';
import { button, card, input, primary } from '../features/samba/components';

interface Mapping { groupSid: string; groupName: string; roleName: string }
interface Settings { enabled: boolean; name: string | null; domain: string | null; autoProvision: boolean; mappings: Mapping[]; roles: { name: string; label: string }[]; users: { id: string; name: string; email: string }[] }
export default function DirectorySettingsPage() {
  const has = useAuth(s => s.has);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [groups, setGroups] = useState<{ sid: string; name: string }[]>([]);
  const [groupSid, setGroupSid] = useState('');
  const [roleName, setRoleName] = useState('handler');
  const [userId, setUserId] = useState('');
  const [username, setUsername] = useState('');
  const [identityChallenge, setIdentityChallenge] = useState<{ userId: string; username: string } | null>(null);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState<{ remove: boolean; mapping: Pick<Mapping, 'groupSid' | 'roleName'> } | null>(null);
  const load = async () => {
    try { setSettings((await api.get<Settings>('/directory/settings')).data); }
    catch { setError('无法读取身份集成配置，请重试。'); }
  };
  const loadGroups = async () => {
    try { setGroups((await api.get('/directory/groups')).data); }
    catch { setError('无法读取 AD 用户组，请检查公司目录服务连接。'); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (settings?.enabled) void loadGroups(); }, [settings?.enabled]);
  const submit = (event: FormEvent) => { event.preventDefault(); setError(''); setChallenge({ remove: false, mapping: { groupSid, roleName } }); };
  return <div className="mx-auto max-w-5xl space-y-6">
    <div><h1 className="text-2xl font-semibold">身份与访问</h1><p className="mt-2 text-sm text-gray-500">保留 Assay 本地账号，按需启用公司身份登录和业务角色映射。</p></div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <div className="grid gap-4 md:grid-cols-2">
      <section className={card + ' p-5'}><h2 className="font-medium">本地账号</h2><p className="mt-2 text-sm text-green-700">可用</p><p className="mt-3 text-sm text-gray-500">未部署 AD 时独立使用。建议保留本地应急管理员。</p></section>
      <section className={card + ' p-5'}><h2 className="font-medium">公司 AD 登录</h2><p className="mt-2 text-sm">{settings ? settings.enabled ? `已启用 · ${settings.domain}` : '未启用' : '正在读取…'}</p><p className="mt-3 text-sm text-gray-500">{settings?.enabled ? settings.autoProvision ? '员工首次登录自动建立业务账号，无需另设 Assay 密码。' : '仅允许已由管理员关联的员工登录。' : '可由部署管理员启用；工单、库存等业务不依赖 AD 或文件服务。'}</p></section>
    </div>
    {settings?.enabled && has('role:manage') && <section className={card + ' space-y-4 p-5'}>
      <div><h2 className="font-semibold">关联已有业务账号</h2><p className="mt-2 text-sm text-gray-500">为已有员工明确指定公司身份，沿用原有工单、库存记录和手工角色。此操作不修改 AD，不需要启用 Samba 文件管理。</p></div>
      <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={event => { event.preventDefault(); setIdentityChallenge({ userId, username: username.trim() }); }}>
        <label className="grid gap-1 text-sm">现有业务账号<select aria-label="现有业务账号" className={input} required value={userId} onChange={event => setUserId(event.target.value)}><option value="">请选择员工</option>{settings.users?.map(user => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select></label>
        <label className="grid gap-1 text-sm">公司账号<input aria-label="公司账号" className={input} required maxLength={254} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></label>
        <button className={primary} disabled={!userId || !username.trim()}>关联现有账号</button>
      </form>
      <p className="text-xs text-gray-500">不会按相同邮箱或姓名自动合并。关联后旧会话失效，员工改用公司账号登录；已关联的身份不能在此直接替换。</p>
    </section>}
    {settings?.enabled && <section className={card + ' space-y-5 p-5'}>
      <div><h2 className="font-semibold">AD 用户组与业务角色</h2><p className="mt-2 text-sm text-gray-500">员工默认获得提单人角色。以下授权随 AD 组成员关系生效，手工授予的角色独立保留。平台超级管理员需显式授权。</p></div>
      {has('role:manage') && <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1 text-sm">AD 用户组<select aria-label="AD 用户组" className={input} required value={groupSid} onChange={e => setGroupSid(e.target.value)}><option value="">请选择用户组</option>{groups.map(g => <option key={g.sid} value={g.sid}>{g.name}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Assay 业务角色<select aria-label="Assay 业务角色" className={input} value={roleName} onChange={e => setRoleName(e.target.value)}>{settings.roles.map(r => <option key={r.name} value={r.name}>{r.label}</option>)}</select></label>
        <button className={primary} disabled={!groupSid}>添加映射</button>
      </form>}
      <div className="divide-y divide-gray-100 dark:divide-gray-800">{settings.mappings.length ? settings.mappings.map(m => <div key={m.groupSid + m.roleName} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{m.groupName} → {settings.roles.find(r => r.name === m.roleName)?.label || m.roleName}</p><p className="mt-1 break-all text-xs text-gray-500">{m.groupSid}</p></div>{has('role:manage') && <button className={button} onClick={() => setChallenge({ remove: true, mapping: { groupSid: m.groupSid, roleName: m.roleName } })}>移除映射</button>}</div>) : <p className="py-4 text-sm text-gray-500">尚未配置额外业务角色映射。</p>}</div>
      <p className="text-xs text-gray-500">目录状态最多缓存 30 秒。文件访问仍由 Samba 的共享权限及文件 ACL 校验。</p>
    </section>}
    {challenge && <StepUpDialog title={challenge.remove ? '移除 AD 角色映射' : '添加 AD 角色映射'} purpose="roles" onCancel={() => setChallenge(null)} onAuthorized={async token => { await guardedApi(challenge.remove ? 'DELETE' : 'POST', '/directory/mappings', token, challenge.mapping); await load(); }} />}
    {identityChallenge && <StepUpDialog title="关联已有业务账号与 AD 身份" purpose="roles" onCancel={() => setIdentityChallenge(null)} onAuthorized={async token => { await guardedApi('POST', '/directory/identities', token, identityChallenge); setUserId(''); setUsername(''); await load(); }} />}
  </div>;
}
