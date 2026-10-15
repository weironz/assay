import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  DataTable,
  Info,
  button,
  card,
  input,
  link,
  primary,
} from './components';
import {
  employeeProfileValues,
  profileFields,
  sameDn,
  type Employee,
  type Workspace,
} from './types';

export function Employees({
  snapshot,
  canWrite,
  open,
  id,
}: Workspace & { id?: string }) {
  const [status, setStatus] = useState('all');
  const [department, setDepartment] = useState('all');
  const users = snapshot.users;
  const employee = users.find((u) => u.id === id);
  const edit = (u: Employee) =>
    open({
      title: '编辑员工资料',
      action: 'user.update',
      fields: [
        { name: 'display_name', label: '员工姓名' },
        ...profileFields,
        { name: 'disabled', label: '停用账号', type: 'checkbox' },
      ],
      values: {
        id: u.id,
        display_name: u.displayName || u.name,
        disabled: u.disabled,
        ...employeeProfileValues(u),
      },
    });
  const create = () =>
    open({
      title: '新增员工账号',
      action: 'user.create',
      description:
        '资料保存到公司 AD。新账号可用于文件共享，不会自动创建 Assay 登录账号。',
      fields: [
        { name: 'name', label: '登录账号' },
        { name: 'display_name', label: '员工姓名' },
        ...profileFields,
        { name: 'password', label: '初始 AD 密码', type: 'password', minLength: 8, hint: '至少 8 个字符，并符合公司 AD 的密码复杂度与历史密码要求。' },
      ],
      values: {
        name: '',
        display_name: '',
        password: '',
        ...employeeProfileValues(),
      },
    });
  if (!id)
    return (
      <DataTable
        label="员工账号"
        rows={users.filter(
          (u) =>
            (status === 'all' || u.disabled === (status === 'disabled')) &&
            (department === 'all' || (u.department || '未填写') === department),
        )}
        rowKey={(u) => u.id}
        searchText={(u) =>
          [
            u.name,
            u.displayName,
            u.employeeId,
            u.email,
            u.department,
            u.title,
          ].join(' ')
        }
        actions={
          <button className={primary} disabled={!canWrite} onClick={create}>
            新增员工
          </button>
        }
        filters={
          <>
            <select
              className={input + ' sm:w-auto'}
              aria-label="账号状态"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="active">已启用</option>
              <option value="disabled">已停用</option>
            </select>
            <select
              className={input + ' sm:w-auto'}
              aria-label="部门筛选"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            >
              <option value="all">全部部门</option>
              {[...new Set(users.map((u) => u.department || '未填写'))]
                .sort()
                .map((d) => (
                  <option key={d}>{d}</option>
                ))}
            </select>
          </>
        }
        columns={[
          {
            label: '员工',
            render: (u) => (
              <div>
                <Link to={`/samba/users/${u.id}`} className={link}>
                  {u.displayName || u.name}
                </Link>
                <p className="mt-1 text-xs text-gray-500">{u.name}</p>
              </div>
            ),
          },
          { label: '工号', render: (u) => u.employeeId || '—' },
          { label: '邮箱', render: (u) => u.email || '—' },
          {
            label: '部门 / 岗位',
            render: (u) => (
              <div>
                {u.department || '—'}
                <p className="mt-1 text-xs text-gray-500">{u.title || '—'}</p>
              </div>
            ),
          },
          {
            label: '状态',
            render: (u) => (
              <Badge muted={u.disabled}>
                {u.disabled ? '已停用' : '已启用'}
              </Badge>
            ),
          },
          {
            label: '操作',
            render: (u) => (
              <Link className={link} to={`/samba/users/${u.id}`}>
                查看详情 →
              </Link>
            ),
          },
        ]}
      />
    );
  if (!employee) return <p>员工不存在或不在管理范围内。</p>;
  const editable = canWrite && employee.manageable !== false;
  const binding = snapshot.bindings.find((b) => b.adObjectId === employee.id);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {employee.displayName || employee.name}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            登录账号：{employee.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge muted={employee.disabled}>
            {employee.disabled ? '已停用' : '已启用'}
          </Badge>
          <button
            className={button}
            disabled={!editable}
            onClick={() => edit(employee)}
          >
            编辑员工资料
          </button>
          <button
            className={button}
            disabled={!editable}
            onClick={() =>
              open({
                title: '重置 AD 密码',
                action: 'user.password',
                fields: [
                  { name: 'password', label: '新的 AD 密码', type: 'password', minLength: 8, hint: '至少 8 个字符，并符合公司 AD 的密码复杂度与历史密码要求。' },
                ],
                values: { id: employee.id, password: '' },
              })
            }
          >
            重置密码
          </button>
        </div>
      </div>
      {employee.manageable === false && (
        <p className="text-sm text-gray-500">
          此账号受 AD 保护或超出 Agent 可写规则，仅允许查看。
        </p>
      )}
      <section className={card + ' p-6'}>
        <h3 className="mb-5 font-semibold">员工资料</h3>
        <dl className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
          <Info label="员工姓名">{employee.displayName}</Info>
          <Info label="工号">{employee.employeeId}</Info>
          <Info label="邮箱">{employee.email}</Info>
          <Info label="部门">{employee.department}</Info>
          <Info label="岗位">{employee.title}</Info>
          <Info label="电话">{employee.phone}</Info>
          <Info label="公司">{employee.company}</Info>
          <Info label="办公地点">{employee.office}</Info>
        </dl>
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">所属用户组</h3>
        <DataTable
          label="所属用户组"
          rows={snapshot.groups.filter((g) =>
            g.members.some((dn) => sameDn(dn, employee.dn)),
          )}
          rowKey={(g) => g.id}
          searchText={(g) => g.name + ' ' + g.description}
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
            { label: '成员数量', render: (g) => g.members.length },
          ]}
        />
      </section>
      <section className={card + ' p-6'}>
        <h3 className="font-semibold">Assay 登录账号</h3>
        <p className="mt-2 text-sm text-gray-500">
          {binding
            ? `已关联：${snapshot.assayUsers.find((u) => u.id === binding.userId)?.email || '已停用的 Assay 用户'}`
            : '尚未关联 Assay 登录账号'}
          。公司 AD 密码与 Assay 登录密码分别管理。
        </p>
        <Link
          className={link + ' mt-3 inline-block text-sm'}
          to="/samba/bindings"
        >
          管理登录账号关联 →
        </Link>
      </section>
      <details className={card + ' p-5 text-sm'}>
        <summary className="cursor-pointer text-gray-500">目录标识</summary>
        <dl className="mt-4 grid gap-4">
          <Info label="AD 对象 ID">{employee.id}</Info>
          <Info label="安全标识 SID">{employee.sid}</Info>
          <Info label="目录位置">{employee.dn}</Info>
        </dl>
      </details>
    </>
  );
}
