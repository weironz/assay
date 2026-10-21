import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { type Msg, useMsg } from '../lib/messages';
import StepUpDialog from '../components/StepUpDialog';
import { guardedApi, securityErrorKey } from '../lib/security-step-up';
import RoleSelector from '../features/access/RoleSelector';
import { toggleRoleSelection, type AssignableRole } from '../features/access/role-selection';
import CreateUserDrawer from '../features/access/CreateUserDrawer';
import { filterUsers } from '../features/access/user-directory';

interface UserRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  status: string;
  roles: string[];
  directoryRoles?: string[];
  directoryAccount?: string | null;
  localPassword?: boolean;
  canSetLocalPassword?: boolean;
  directoryLogin?: boolean;
}

export default function UsersPage() {
  const { t } = useTranslation();
  const showMsg = useMsg();
  const qc = useQueryClient();
  const { data: users, isPending: usersLoading, isError: usersFailed, refetch: retryUsers } = useQuery<UserRow[]>({
    queryKey: ['users'],
    queryFn: async () => (await api.get('/users')).data,
  });
  const { data: roles, isPending: rolesLoading, isError: rolesFailed, refetch: retryRoles } = useQuery<AssignableRole[]>({
    queryKey: ['roles'],
    queryFn: async () => (await api.get('/roles')).data,
  });

  const [creating, setCreating] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleError, setRoleError] = useState('');
  const roleSaving = useRef(false);
  const [challenge, setChallenge] = useState<{ title: string; run: (token: string) => Promise<void> } | null>(null);
  const rolePanel = useRef<HTMLDivElement>(null);
  const roleOpener = useRef<HTMLButtonElement>(null);
  const roleSaveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!editing) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => rolePanel.current?.querySelector<HTMLElement>('input, button')?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      if (previous?.isConnected && !document.querySelector('[data-step-up-dialog]')) previous.focus();
    };
  }, [editing]);
  const roleKeys = (event: KeyboardEvent) => {
    if (roleBusy) return;
    if (event.key === 'Escape') { event.preventDefault(); setEditing(null); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(rolePanel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), summary') || [])];
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  };
  const roleLabel = (name: string) => {
    const role = roles?.find((item) => item.name === name);
    return t(`access.roles.${name}`, { defaultValue: role?.description || name });
  };

  const refreshUsers = () => { void qc.invalidateQueries({ queryKey: ['users'] }); };
  const openEdit = (u: UserRow, opener: HTMLButtonElement) => {
    roleOpener.current = opener;
    setEditing(u);
    setEditRoles(u.roles);
    setRoleError('');
  };
  const saveRoles = async () => {
    if (!editing || roleSaving.current) return;
    roleSaving.current = true; setRoleBusy(true); setRoleError('');
    try {
      await guardedApi('PATCH', `/users/${editing.id}`, '', { roleNames: [...editRoles] });
      refreshUsers(); setEditing(null);
    } catch (error) { setRoleError(securityErrorKey(error)); }
    finally { roleSaving.current = false; setRoleBusy(false); }
  };
  const toggleEditRole = (name: string) =>
    setEditRoles((r) => toggleRoleSelection(r, name));

  const resetPwd = (u: UserRow) => {
    const pwd = prompt(t('users.resetPrompt', { name: u.name }));
    if (!pwd) return;
    if (pwd.length < 6) return alert(t('users.errPasswordTooShort'));
    setChallenge({ title: `${t('users.resetPassword')} · ${u.name}`, run: async (token) => {
      await guardedApi('POST', `/users/${u.id}/reset-password`, token, { newPassword: pwd });
      setMsg({ key: 'users.passwordReset' });
    } });
  };

  const visibleUsers = filterUsers(users ?? [], userSearch, roleLabel);

  return (
    <div className="space-y-6">
      <div inert={creating || editing ? true : undefined} className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h1 className="text-xl font-semibold">{t('users.title')}</h1><p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('access.create.listHint')}</p></div>
          <button type="button" onClick={() => { setMsg(null); setCreating(true); }} disabled={!!challenge}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-brand-700 px-4 text-sm text-white hover:bg-brand-800 disabled:opacity-50">
            <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2v12M2 8h12" /></svg>{t('users.create')}
          </button>
        </div>
        {msg && <p role="status" className="rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300">{showMsg(msg)}</p>}

      {/* 用户列表 */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-800">
          <label className="relative w-full sm:max-w-md"><span className="sr-only">{t('access.create.searchUsers')}</span>
            <svg aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
            <input type="search" value={userSearch} onChange={event => setUserSearch(event.target.value)} placeholder={t('access.create.searchUsers')}
              className="min-h-11 w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-base sm:text-sm dark:border-gray-600 dark:bg-gray-950" />
          </label>
          <p role="status" className="text-xs text-gray-500 dark:text-gray-400">{t('access.create.userCount', { count: visibleUsers.length, total: users?.length ?? 0 })}</p>
        </div>
        <div className="overflow-x-auto">
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
            {visibleUsers.map((u) => (
              <tr
                key={u.id}
                className="border-t border-gray-100 dark:border-gray-800"
              >
                <td className="px-4 py-2">{u.name}{u.directoryAccount && <p className="mt-1 text-xs text-gray-500">AD · {u.directoryAccount}</p>}</td>
                <td className="px-4 py-2 text-gray-500">{u.email}</td>
                <td className="max-w-80 px-4 py-2"><div className="flex flex-wrap gap-1.5">{u.roles.map(name => <span key={name} title={name} className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800">{roleLabel(name)}</span>)}</div>{!!u.directoryRoles?.length && <p className="mt-1 text-xs text-gray-500">{t('users.directoryRoles')}：{u.directoryRoles.map(roleLabel).join(', ')}</p>}</td>
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
                    disabled={u.directoryLogin || (u.localPassword === false && !u.canSetLocalPassword)}
                    title={u.directoryLogin || (u.localPassword === false && !u.canSetLocalPassword) ? t('users.directoryPassword') : undefined}
                    className="inline-flex min-h-11 items-center text-amber-700 hover:underline focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-400"
                  >
                    {t(u.localPassword === false && u.canSetLocalPassword ? 'users.setLocalPassword' : 'users.resetPassword')}
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
            {(usersLoading || usersFailed || !visibleUsers.length) && <tr><td colSpan={5} className="px-4 py-12 text-center text-sm text-gray-600 dark:text-gray-400">
              {usersLoading ? <p role="status">{t('common.loading')}</p> : usersFailed ? <div role="alert"><p>{t('access.create.usersFailed')}</p><button type="button" onClick={() => void retryUsers()} className="mt-2 min-h-11 px-3 text-brand-700 dark:text-brand-300">{t('access.retry')}</button></div> :
                <><p>{t('access.create.noUsers')}</p>{userSearch && <button type="button" onClick={() => setUserSearch('')} className="mt-2 min-h-11 px-3 text-brand-700 dark:text-brand-300">{t('access.clear')}</button>}</>}
            </td></tr>}
          </tbody>
        </table>
        </div>
      </div>
      </div>

      {creating && <CreateUserDrawer roles={roles ?? []} loading={rolesLoading} failed={rolesFailed} onRetry={() => void retryRoles()}
        onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); setUserSearch(''); refreshUsers(); setMsg({ key: 'users.created' }); }} />}

      {/* 编辑角色弹窗 */}
      {editing && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/40 p-3 sm:p-6"
          onClick={() => { if (!roleBusy) setEditing(null); }}
        >
          <div
            ref={rolePanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-roles-title"
            onKeyDown={roleKeys}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[calc(100dvh-2rem)] w-full max-w-5xl overflow-y-auto rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 sm:p-6 space-y-4"
          >
            <h2 id="edit-roles-title" className="text-lg font-semibold">
              {t('users.editRolesTitle', { name: editing.name })}
            </h2>
            <p className="break-all text-sm text-gray-500 dark:text-gray-400">{editing.email}</p>
            {!!editing.directoryRoles?.length && <div className="rounded-md bg-gray-50 p-3 text-xs dark:bg-gray-800"><p className="font-medium">{t('access.inherited')}：{editing.directoryRoles.map(roleLabel).join(', ')}</p><p className="mt-1 text-gray-500 dark:text-gray-400">{t('access.inheritedHint')}</p></div>}
            <RoleSelector key={editing.id} roles={roles ?? []} selected={editRoles} onToggle={toggleEditRole} disabled={roleBusy}
              loading={rolesLoading} failed={rolesFailed} onRetry={() => void retryRoles()} />
            {editRoles.length === 0 && (
              <p className="text-xs text-amber-600">
                {t('users.noBusinessRoles')}
              </p>
            )}
            {roleError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(roleError)}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setEditing(null)}
                disabled={roleBusy}
                className="min-h-11 rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {t('common.cancel')}
              </button>
              <button
                ref={roleSaveButton}
                onClick={() => void saveRoles()}
                disabled={roleBusy || rolesLoading || rolesFailed}
                className="min-h-11 rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {t(roleBusy ? 'common.processing' : 'common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
      {challenge && <StepUpDialog purpose="roles" title={challenge.title} onCancel={() => setChallenge(null)} onAuthorized={(token) => challenge.run(token)} preferredFocus={editing ? roleSaveButton.current : null} fallbackFocus={roleOpener.current} />}
    </div>
  );
}
