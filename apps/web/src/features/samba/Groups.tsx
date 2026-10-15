import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, DataTable, button, card, link, primary } from './components';
import { employeeLabel, sameDn, type Group, type Workspace } from './types';

export function Groups({
  snapshot,
  canWrite,
  open,
  confirm,
  id,
}: Workspace & { id?: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const groups = snapshot.groups;
  const group = groups.find((g) => g.id === id);
  const add = (g: Group) =>
    open({
      title: '添加组成员',
      action: 'group.members',
      description:
        '搜索并多选员工，一次最多添加 100 名。已在组内的员工不会重复显示。',
      fields: [
        {
          name: 'user_ids',
          label: '选择员工',
          type: 'multi',
          options: snapshot.users
            .filter(
              (u) =>
                u.manageable !== false &&
                !g.members.some((dn) => sameDn(dn, u.dn)),
            )
            .map((u) => ({ value: u.id, label: employeeLabel(u) })),
        },
      ],
      values: { group_id: g.id, user_ids: [], add: true },
    });
  if (!id)
    return (
      <DataTable
        label="用户组"
        rows={groups}
        rowKey={(g) => g.id}
        searchText={(g) => g.name + ' ' + g.description}
        actions={
          <button
            className={primary}
            disabled={!canWrite}
            onClick={() =>
              open({
                title: '新增用户组',
                action: 'group.create',
                fields: [
                  { name: 'name', label: '用户组名称' },
                  { name: 'description', label: '说明' },
                ],
                values: { name: '', description: '' },
              })
            }
          >
            新增用户组
          </button>
        }
        columns={[
          {
            label: '用户组',
            render: (g) => (
              <Link className={link} to={`/samba/groups/${g.id}`}>
                {g.name}
              </Link>
            ),
          },
          { label: '说明', render: (g) => g.description },
          {
            label: '成员数量',
            render: (g) => <Badge muted>{g.members.length} 名</Badge>,
          },
          {
            label: '授权目录',
            render: (g) =>
              snapshot.shares.filter((s) => s.groups.includes(g.name)).length,
          },
          {
            label: '操作',
            render: (g) => (
              <Link className={link} to={`/samba/groups/${g.id}`}>
                管理成员 →
              </Link>
            ),
          },
        ]}
      />
    );
  if (!group)
    return (
      <p>
        用户组不存在或已删除。
        <Link to="/samba/groups" className={link}>
          返回列表
        </Link>
      </p>
    );
  const editable = canWrite && group.manageable !== false;
  const members = group.members.map((dn) => ({
    dn,
    user: snapshot.users.find((u) => sameDn(u.dn, dn)),
  }));
  const removable = members
    .filter((m) => m.user && m.user.manageable !== false)
    .map((m) => m.user!.id);
  const selectedIds = selected.filter((v) => removable.includes(v));
  const referenced = snapshot.shares.filter((s) =>
    s.groups.includes(group.name),
  );
  const reason =
    group.manageable === false
      ? '此用户组受 AD 保护，仅允许查看。'
      : group.members.length
        ? '请先移出全部成员，再删除用户组。'
        : referenced.length
          ? '请先从授权目录的访问组中移除此用户组，再删除。'
          : '';
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{group.name}</h2>
          <p className="mt-1 text-sm text-gray-500">{group.description}</p>
        </div>
        <button
          className={button}
          disabled={!editable}
          onClick={() =>
            open({
              title: '编辑用户组',
              action: 'group.update',
              fields: [{ name: 'description', label: '说明' }],
              values: { id: group.id, description: group.description },
            })
          }
        >
          编辑用户组
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ['直接成员', members.length],
          ['授权目录', referenced.length],
          ['已选成员', selectedIds.length],
        ].map(([label, count]) => (
          <div key={label} className={card + ' p-5'}>
            <p className="text-sm text-gray-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold">{count}</p>
          </div>
        ))}
      </div>
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">成员列表</h3>
          <span className="text-xs text-gray-500">
            移出用户组只取消成员关系，不删除员工账号。
          </span>
        </div>
        <DataTable
          label="组成员"
          rows={members}
          rowKey={(m) => m.dn}
          searchText={(m) =>
            m.user ? employeeLabel(m.user) + ' ' + m.user.email : m.dn
          }
          actions={
            <>
              <button
                className={button}
                disabled={
                  !editable || !selectedIds.length || selectedIds.length > 100
                }
                onClick={() =>
                  confirm(
                    `移出 ${selectedIds.length} 名组成员`,
                    'group.members',
                    { group_id: group.id, user_ids: selectedIds, add: false },
                  )
                }
              >
                移出所选成员
              </button>
              <button
                className={primary}
                disabled={!editable}
                onClick={() => add(group)}
              >
                添加成员
              </button>
            </>
          }
          columns={[
            {
              label: (
                <input
                  type="checkbox"
                  aria-label="选择全部可管理成员（最多100名）"
                  disabled={!editable || !removable.length}
                  checked={
                    removable.length > 0 &&
                    removable
                      .slice(0, 100)
                      .every((v) => selectedIds.includes(v))
                  }
                  onChange={(e) =>
                    setSelected(e.target.checked ? removable.slice(0, 100) : [])
                  }
                />
              ),
              render: (m) => (
                <input
                  type="checkbox"
                  aria-label={`选择成员 ${m.user?.name || m.dn}`}
                  disabled={!editable || !m.user || m.user.manageable === false}
                  checked={!!m.user && selectedIds.includes(m.user.id)}
                  onChange={(e) => {
                    if (m.user)
                      setSelected(
                        e.target.checked
                          ? [...selectedIds, m.user.id]
                          : selectedIds.filter((v) => v !== m.user!.id),
                      );
                  }}
                />
              ),
            },
            {
              label: '员工',
              render: (m) =>
                m.user ? (
                  <div>
                    <Link className={link} to={`/samba/users/${m.user.id}`}>
                      {m.user.displayName || m.user.name}
                    </Link>
                    <p className="mt-1 text-xs text-gray-500">{m.user.name}</p>
                  </div>
                ) : (
                  <span className="break-all text-xs">{m.dn}</span>
                ),
            },
            { label: '工号', render: (m) => m.user?.employeeId || '—' },
            {
              label: '部门 / 岗位',
              render: (m) =>
                m.user
                  ? `${m.user.department || '—'} / ${m.user.title || '—'}`
                  : '不在受管员工范围内',
            },
            {
              label: '状态',
              render: (m) => (
                <Badge muted={!m.user || m.user.disabled}>
                  {m.user
                    ? m.user.disabled
                      ? '已停用'
                      : '已启用'
                    : '外部成员'}
                </Badge>
              ),
            },
            {
              label: '操作',
              render: (m) =>
                m.user && m.user.manageable !== false ? (
                  <button
                    className={button}
                    disabled={!editable}
                    onClick={() =>
                      confirm(
                        `移出成员 ${m.user!.displayName || m.user!.name}`,
                        'group.members',
                        {
                          group_id: group.id,
                          user_ids: [m.user!.id],
                          add: false,
                        },
                      )
                    }
                  >
                    移出成员
                  </button>
                ) : (
                  <span className="text-xs text-gray-500">
                    受保护或不在管理范围内，请由 AD 管理员处理
                  </span>
                ),
            },
          ]}
        />
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">授权目录</h3>
        <DataTable
          label="用户组授权目录"
          rows={referenced}
          rowKey={(s) => s.name}
          searchText={(s) => s.name + ' ' + s.comment}
          columns={[
            {
              label: '目录名称',
              render: (s) => (
                <Link className={link} to={`/samba/shares/${s.name}`}>
                  {s.name}
                </Link>
              ),
            },
            { label: '说明', render: (s) => s.comment },
            {
              label: '状态',
              render: (s) => (s.active ? '已发布' : '已移除（文件保留）'),
            },
          ]}
        />
      </section>
      <section
        className={
          card + ' flex flex-wrap items-center justify-between gap-4 p-5'
        }
      >
        <div>
          <h3 className="font-medium">删除用户组</h3>
          <p className="mt-1 text-sm text-gray-500">
            {reason || '删除空组不会删除员工账号或目录文件。'}
          </p>
        </div>
        <button
          className={button + ' text-red-600'}
          disabled={!editable || !!reason}
          title={reason || undefined}
          onClick={() =>
            confirm('删除空用户组', 'group.delete', { id: group.id })
          }
        >
          删除用户组
        </button>
      </section>
    </>
  );
}
