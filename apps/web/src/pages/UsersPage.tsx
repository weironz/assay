import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { type Msg, useMsg } from '../lib/messages';
import StepUpDialog from '../components/StepUpDialog';
import { guardedApi } from '../lib/security-step-up';

interface UserRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  status: string;
  roles: string[];
}
interface Role {
  id: string;
  name: string;
  description: string | null;
}

export default function UsersPage() {
  const { t } = useTranslation();
  const showMsg = useMsg();
  const qc = useQueryClient();
  const { data: users } = useQuery<UserRow[]>({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/users')).data,
  });
  const { data: roles } = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: async () => (await api.get('/roles')).data,
  });

  const [form, setForm] = useState({
    email: '',
    name: '',
    password: '',
    roleNames: [] as string[],
  });
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [challenge, setChallenge] = useState<{ title: string; run: (token: string) => Promise<void> } | null>(null);
  const rolePanel = useRef<HTMLDivElement>(null);
  const roleOpener = useRef<HTMLButtonElement>(null);
  const roleSaveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!editing) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => rolePanel.current?.querySelector<HTMLElement>('input, button')?.focus());
    return () => { if (previous?.isConnected && !document.querySelector('[data-step-up-dialog]')) previous.focus(); };
  }, [editing]);
  const roleKeys = (event: KeyboardEvent) => {
    if (challenge) return;
    if (event.key === 'Escape') { event.preventDefault(); setEditing(null); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(rolePanel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') || [])];
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  };
  const roleLabel = (name: string) => {
    const role = roles?.find((item) => item.name === name);
    return role?.description ? `${role.description} · ${name}` : name;
  };

  const refreshUsers = () => { void qc.invalidateQueries({ queryKey: ['users'] }); };
  const openEdit = (u: UserRow, opener: HTMLButtonElement) => {
    roleOpener.current = opener;
    setEditing(u);
    setEditRoles(u.roles);
  };
  const toggleEditRole = (name: string) =>
    setEditRoles((r) =>
      r.includes(name) ? r.filter((x) => x !== name) : [...r, name],
    );

  const resetPwd = (u: UserRow) => {
    const pwd = prompt(t('users.resetPrompt', { name: u.name }));
    if (!pwd) return;
    if (pwd.length < 6) return alert(t('users.errPasswordTooShort'));
    setChallenge({ title: `${t('users.resetPassword')} · ${u.name}`, run: async (token) => {
      await guardedApi('POST', `/users/${u.id}/reset-password`, token, { newPassword: pwd });
      setMsg({ key: 'users.passwordReset' });
    } });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const values = { ...form, roleNames: [...form.roleNames] };
    setChallenge({ title: t('users.create'), run: async (token) => {
      await guardedApi('POST', '/users', token, values);
      refreshUsers();
      setForm({ email: '', name: '', password: '', roleNames: [] });
      setMsg({ key: 'users.created' });
    } });
  };

  const toggleRole = (name: string) =>
    setForm((f) => ({
      ...f,
      roleNames: f.roleNames.includes(name)
        ? f.roleNames.filter((r) => r !== name)
        : [...f.roleNames, name],
    }));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t('users.title')}</h1>

      {/* 新建用户 */}
      <form
        onSubmit={submit}
        className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
      >
        <label className="grid gap-1 text-sm font-medium">{t('users.emailPlaceholder')}<input
          placeholder={t('users.emailPlaceholder')}
          aria-label={t('users.emailPlaceholder')}
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className="min-h-11 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-brand-500"
        /></label>
        <label className="grid gap-1 text-sm font-medium">{t('users.namePlaceholder')}<input
          placeholder={t('users.namePlaceholder')}
          aria-label={t('users.namePlaceholder')}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="min-h-11 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-brand-500"
        /></label>
        <label className="grid gap-1 text-sm font-medium">{t('users.passwordPlaceholder')}<input
          placeholder={t('users.passwordPlaceholder')}
          aria-label={t('users.passwordPlaceholder')}
          type="password"
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          className="min-h-11 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-brand-500"
        /></label>
        <button
          type="submit"
          disabled={!!challenge || form.roleNames.length === 0}
          className="min-h-11 rounded-md bg-brand-700 px-4 text-white text-sm hover:bg-brand-800 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {t('users.create')}
        </button>
        <div className="md:col-span-4 flex flex-wrap gap-3 text-sm">
          <span className="text-gray-500">{t('users.rolesLabel')}</span>
          {roles?.map((r) => (
            <label key={r.id} className="flex min-h-11 items-center gap-1.5">
              <input
                type="checkbox"
                checked={form.roleNames.includes(r.name)}
                onChange={() => toggleRole(r.name)}
              />
              <span>{r.description ?? r.name}</span>
              <code className="text-xs text-gray-400">{r.name}</code>
            </label>
          ))}
        </div>
        <p className="md:col-span-4 text-xs text-gray-500 dark:text-gray-400">
          {t('users.fixedRolesHint')}
        </p>
        {msg && (
          <p role="alert" className="md:col-span-4 text-sm text-gray-700 dark:text-gray-200">{showMsg(msg)}</p>
        )}
      </form>

      {/* 用户列表 */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">{t('common.name')}</th>
              <th className="text-left px-4 py-2">{t('common.email')}</th>
              <th className="text-left px-4 py-2">{t('common.roles')}</th>
              <th className="text-left px-4 py-2">{t('common.status')}</th>
              <th className="text-right px-4 py-2">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr
                key={u.id}
                className="border-t border-gray-100 dark:border-gray-800"
              >
                <td className="px-4 py-2">{u.name}</td>
                <td className="px-4 py-2 text-gray-500">{u.email}</td>
                <td className="px-4 py-2">{u.roles.map(roleLabel).join(', ')}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      u.status === 'ACTIVE' ? 'text-green-600' : 'text-gray-400'
                    }
                  >
                    {u.status === 'ACTIVE'
                      ? t('users.statusActive')
                      : t('users.statusDisabled')}
                  </span>
                </td>
                <td className="px-4 py-2 text-right space-x-3">
                  <button
                    onClick={(event) => openEdit(u, event.currentTarget)}
                    className="inline-flex min-h-11 items-center text-brand-700 hover:underline focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {t('users.editRoles')}
                  </button>
                  <button
                    onClick={() => setChallenge({ title: `${t(u.status === 'ACTIVE' ? 'users.disable' : 'users.enable')} · ${u.name}`, run: async (token) => { await guardedApi('PATCH', `/users/${u.id}`, token, { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }); refreshUsers(); } })}
                    className="inline-flex min-h-11 items-center text-brand-700 hover:underline focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {u.status === 'ACTIVE'
                      ? t('users.disable')
                      : t('users.enable')}
                  </button>
                  <button
                    onClick={() => resetPwd(u)}
                    className="inline-flex min-h-11 items-center text-amber-700 hover:underline focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-400"
                  >
                    {t('users.resetPassword')}
                  </button>
                  <button
                    onClick={() => { if (!window.confirm(t('users.deleteConfirm', { name: u.name }))) return; setChallenge({ title: t('users.deleteConfirm', { name: u.name }), run: async (token) => { await guardedApi('DELETE', `/users/${u.id}`, token); refreshUsers(); } }); }}
                    className="inline-flex min-h-11 items-center text-red-700 hover:underline focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400"
                  >
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 编辑角色弹窗 */}
      {editing && (
        <div
          inert={!!challenge}
          aria-hidden={challenge ? true : undefined}
          className="fixed inset-0 z-30 flex items-center justify-center overflow-y-auto bg-black/40 p-4"
          onClick={() => setEditing(null)}
        >
          <div
            ref={rolePanel}
            role="dialog"
            aria-modal={challenge ? undefined : true}
            aria-labelledby="edit-roles-title"
            onKeyDown={roleKeys}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 space-y-4"
          >
            <h2 id="edit-roles-title" className="text-lg font-semibold">
              {t('users.editRolesTitle', { name: editing.name })}
            </h2>
            <div className="space-y-2">
              {roles?.map((r) => (
                <label key={r.id} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editRoles.includes(r.name)}
                    onChange={() => toggleEditRole(r.name)}
                  />
                  <span>{r.description ?? r.name}</span>
                  <code className="text-xs text-gray-400">{r.name}</code>
                </label>
              ))}
            </div>
            {editRoles.length === 0 && (
              <p className="text-xs text-amber-600">
                {t('users.atLeastOneRole')}
              </p>
            )}
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setEditing(null)}
                className="min-h-11 rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {t('common.cancel')}
              </button>
              <button
                ref={roleSaveButton}
                onClick={() => { if (!editing) return; const id = editing.id; const roleNames = [...editRoles]; setChallenge({ title: t('users.editRolesTitle', { name: editing.name }), run: async (token) => { await guardedApi('PATCH', `/users/${id}`, token, { roleNames }); refreshUsers(); setEditing(null); } }); }}
                disabled={!!challenge || editRoles.length === 0}
                className="min-h-11 rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
      {challenge && <StepUpDialog purpose="roles" title={challenge.title} onCancel={() => setChallenge(null)} onAuthorized={(token) => challenge.run(token)} preferredFocus={editing ? roleSaveButton.current : null} fallbackFocus={roleOpener.current} />}
    </div>
  );
}
