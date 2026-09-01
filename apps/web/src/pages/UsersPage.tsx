import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { type Msg, useMsg } from '../lib/messages';

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

  const createMut = useMutation({
    mutationFn: async () => (await api.post('/users', form)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setForm({ email: '', name: '', password: '', roleNames: [] });
      setMsg({ key: 'users.created' });
    },
    onError: (e: any) =>
      setMsg(
        e?.response?.data?.message
          ? { raw: e.response.data.message }
          : { key: 'users.errCreateFailed' },
      ),
  });

  const toggleMut = useMutation({
    mutationFn: async (u: UserRow) =>
      (
        await api.patch(`/users/${u.id}`, {
          status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const delMut = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/users/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const roleMut = useMutation({
    mutationFn: async () =>
      (await api.patch(`/users/${editing!.id}`, { roleNames: editRoles })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setEditing(null);
    },
    onError: (e: any) =>
      alert(e?.response?.data?.message || t('users.errSaveFailed')),
  });

  const openEdit = (u: UserRow) => {
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
    api
      .post(`/users/${u.id}/reset-password`, { newPassword: pwd })
      .then(() => alert(t('users.passwordReset')))
      .catch((e) =>
        alert(e?.response?.data?.message || t('users.errResetFailed')),
      );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    createMut.mutate();
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
        <input
          placeholder={t('users.emailPlaceholder')}
          aria-label={t('users.emailPlaceholder')}
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <input
          placeholder={t('users.namePlaceholder')}
          aria-label={t('users.namePlaceholder')}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <input
          placeholder={t('users.passwordPlaceholder')}
          aria-label={t('users.passwordPlaceholder')}
          type="password"
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={createMut.isPending || form.roleNames.length === 0}
          className="rounded-md bg-brand-700 text-white py-2 text-sm hover:bg-brand-800 disabled:opacity-60"
        >
          {t('users.create')}
        </button>
        <div className="md:col-span-4 flex flex-wrap gap-3 text-sm">
          <span className="text-gray-500">{t('users.rolesLabel')}</span>
          {roles?.map((r) => (
            <label key={r.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={form.roleNames.includes(r.name)}
                onChange={() => toggleRole(r.name)}
              />
              {r.name}
              {r.description ? `(${r.description})` : ''}
            </label>
          ))}
        </div>
        {msg && (
          <p className="md:col-span-4 text-sm text-gray-500">{showMsg(msg)}</p>
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
                <td className="px-4 py-2">{u.roles.join(', ')}</td>
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
                    onClick={() => openEdit(u)}
                    className="text-brand-700 hover:underline"
                  >
                    {t('users.editRoles')}
                  </button>
                  <button
                    onClick={() => toggleMut.mutate(u)}
                    className="text-brand-700 hover:underline"
                  >
                    {u.status === 'ACTIVE'
                      ? t('users.disable')
                      : t('users.enable')}
                  </button>
                  <button
                    onClick={() => resetPwd(u)}
                    className="text-amber-600 hover:underline"
                  >
                    {t('users.resetPassword')}
                  </button>
                  <button
                    onClick={() => delMut.mutate(u.id)}
                    className="text-red-500 hover:underline"
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
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40"
          onClick={() => setEditing(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-6 space-y-4"
          >
            <h2 className="text-lg font-semibold">
              {t('users.editRolesTitle', { name: editing.name })}
            </h2>
            <div className="space-y-2">
              {roles?.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editRoles.includes(r.name)}
                    onChange={() => toggleEditRole(r.name)}
                  />
                  {r.name}
                  {r.description ? (
                    <span className="text-gray-400">（{r.description}）</span>
                  ) : null}
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
                className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => roleMut.mutate()}
                disabled={roleMut.isPending || editRoles.length === 0}
                className="rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800 disabled:opacity-60"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
