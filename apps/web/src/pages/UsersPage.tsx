import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

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
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);

  const createMut = useMutation({
    mutationFn: async () => (await api.post('/users', form)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setForm({ email: '', name: '', password: '', roleNames: [] });
      setMsg('创建成功');
    },
    onError: (e: any) => setMsg(e?.response?.data?.message || '创建失败'),
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
    onError: (e: any) => alert(e?.response?.data?.message || '保存失败'),
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
    const pwd = prompt(`为「${u.name}」设置新密码（≥6 位）：`);
    if (!pwd) return;
    if (pwd.length < 6) return alert('密码至少 6 位');
    api
      .post(`/users/${u.id}/reset-password`, { newPassword: pwd })
      .then(() => alert('密码已重置'))
      .catch((e) => alert(e?.response?.data?.message || '重置失败'));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
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
      <h1 className="text-xl font-semibold">用户管理</h1>

      {/* 新建用户 */}
      <form
        onSubmit={submit}
        className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
      >
        <input
          placeholder="邮箱"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <input
          placeholder="姓名"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <input
          placeholder="初始密码(≥6位)"
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
          新建用户
        </button>
        <div className="md:col-span-4 flex flex-wrap gap-3 text-sm">
          <span className="text-gray-500">角色：</span>
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
        {msg && <p className="md:col-span-4 text-sm text-gray-500">{msg}</p>}
      </form>

      {/* 用户列表 */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">姓名</th>
              <th className="text-left px-4 py-2">邮箱</th>
              <th className="text-left px-4 py-2">角色</th>
              <th className="text-left px-4 py-2">状态</th>
              <th className="text-right px-4 py-2">操作</th>
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
                      u.status === 'ACTIVE'
                        ? 'text-green-600'
                        : 'text-gray-400'
                    }
                  >
                    {u.status === 'ACTIVE' ? '正常' : '已禁用'}
                  </span>
                </td>
                <td className="px-4 py-2 text-right space-x-3">
                  <button
                    onClick={() => openEdit(u)}
                    className="text-brand-700 hover:underline"
                  >
                    编辑角色
                  </button>
                  <button
                    onClick={() => toggleMut.mutate(u)}
                    className="text-brand-700 hover:underline"
                  >
                    {u.status === 'ACTIVE' ? '禁用' : '启用'}
                  </button>
                  <button
                    onClick={() => resetPwd(u)}
                    className="text-amber-600 hover:underline"
                  >
                    重置密码
                  </button>
                  <button
                    onClick={() => delMut.mutate(u.id)}
                    className="text-red-500 hover:underline"
                  >
                    删除
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
              编辑角色 · {editing.name}
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
              <p className="text-xs text-amber-600">至少选择一个角色</p>
            )}
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setEditing(null)}
                className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm"
              >
                取消
              </button>
              <button
                onClick={() => roleMut.mutate()}
                disabled={roleMut.isPending || editRoles.length === 0}
                className="rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800 disabled:opacity-60"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
