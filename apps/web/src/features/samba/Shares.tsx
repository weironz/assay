import { useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Rename } from './Rename';
import {
  Badge,
  DataTable,
  Info,
  button,
  card,
  link,
  primary,
} from './components';
import { employeeLabel, type Acl, type Share, type Workspace } from './types';

const permissions = [
  { value: 'read', label: '读取' },
  { value: 'modify', label: '修改（读写删除）' },
  { value: 'full', label: '完全控制（含权限管理）' },
  { value: 'remove', label: '移除直接授权' },
];
export function Shares({
  snapshot,
  canWrite,
  open,
  confirm,
  id,
  refresh,
  onError,
}: Workspace & {
  id?: string;
  refresh: number;
  onError: (message: string) => void;
}) {
  const share = snapshot.shares.find((s) => s.id === id || s.name === id);
  const [path, setPath] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [acl, setAcl] = useState<Acl | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const groupOptions = snapshot.groups
    .filter((g) => g.manageable !== false)
    .map((g) => ({ value: g.id, label: g.name }));
  const userOptions = snapshot.users
    .filter((u) => u.manageable !== false)
    .map((u) => ({ value: u.id, label: employeeLabel(u) }));
  const principalName = (sid?: string) =>
    snapshot.groups.find((g) => g.sid === sid)?.name ||
    snapshot.users.find((u) => u.sid === sid)?.displayName ||
    sid ||
    '高级权限条目';
  async function loadDirectory(p = path) {
    const sequence = ++request.current;
    setDirectories([]);
    setAcl(null);
    if (!share?.active) {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const query = new URLSearchParams({ share: share.name, path: p });
      const [d, a] = await Promise.all([
        api.get(`/samba/directories?${query}`),
        api.get(`/samba/acl?${query}`),
      ]);
      if (sequence !== request.current) return;
      setDirectories(d.data.directories);
      setAcl(a.data);
    } catch (e) {
      if (sequence === request.current)
        onError(
          (e as { response?: { data?: { message?: string } } }).response?.data
            ?.message || '目录或权限加载失败',
        );
    } finally {
      if (sequence === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    void loadDirectory();
    return () => {
      ++request.current;
    };
  }, [id, path, share?.active, refresh]);
  const removeDirectory = () => {
    confirm('删除空目录', 'directory.delete', { share: share?.name, path }, () =>
      setPath(path.split('/').slice(0, -1).join('/')),
    );
  };
  const edit = (s?: Share) =>
    open({
      title: s ? (s.active ? '编辑共享目录' : '恢复共享目录') : '新增共享目录',
      action: 'share.save',
      description:
        '访问组决定谁可以连接共享；目录内读写权限在详情页的 Windows 权限中管理。',
      fields: [
        ...(!s ? [{ name: 'name', label: '目录名称' }] : []),
        { name: 'comment', label: '说明' },
        {
          name: 'groups',
          label: '允许访问的用户组',
          type: 'multi',
          options: groupOptions,
        },
        { name: 'read_only', label: '共享只读', type: 'checkbox' },
      ],
      values: {
        name: s?.name || '',
        comment: s?.comment || '',
        groups: snapshot.groups
          .filter((g) => s?.groups.includes(g.name))
          .map((g) => g.id),
        read_only: s?.read_only || false,
      },
    });
  const grant = (isGroup: boolean) =>
    acl &&
    open({
      title: isGroup ? '设置用户组目录权限' : '设置员工目录权限',
      action: 'acl.grant',
      fields: [
        {
          name: 'principal_id',
          label: isGroup ? '用户组' : '员工账号',
          type: 'select',
          options: isGroup ? groupOptions : userOptions,
        },
        {
          name: 'mode',
          label: '访问权限',
          type: 'select',
          options: isGroup
            ? permissions
            : permissions.filter((p) => p.value !== 'full'),
        },
        { name: 'inherit', label: '应用到子目录与文件', type: 'checkbox' },
      ],
      values: {
        share: share?.name,
        path,
        principal_id: (isGroup ? groupOptions : userOptions)[0]?.value,
        group: isGroup,
        mode: 'read',
        inherit: true,
        revision: acl.revision,
      },
    });
  if (!id)
    return (
      <DataTable
        label="共享目录"
        rows={snapshot.shares}
        rowKey={(s) => s.name}
        searchText={(s) => s.name + ' ' + s.comment}
        actions={
          <button
            className={primary}
            disabled={!canWrite}
            onClick={() => edit()}
          >
            新增目录
          </button>
        }
        columns={[
          {
            label: '目录名称',
            render: (s) => (
              <Link className={link} to={`/samba/shares/${s.id || s.name}`}>
                {s.name}
              </Link>
            ),
          },
          { label: '说明', render: (s) => s.comment },
          {
            label: '访问组数量',
            render: (s) => <Badge muted>{s.groups.length} 个组</Badge>,
          },
          {
            label: '访问模式',
            render: (s) => (s.read_only ? '共享只读' : '按目录权限'),
          },
          {
            label: '状态',
            render: (s) => (
              <Badge muted={!s.active}>{s.active ? '已发布' : '已移除'}</Badge>
            ),
          },
          {
            label: '操作',
            render: (s) => (
              <Link className={link} to={`/samba/shares/${s.id || s.name}`}>
                查看详情 →
              </Link>
            ),
          },
        ]}
      />
    );
  if (!share) return <p>目录不存在或不在管理范围内。</p>;
  if (share.id && id !== share.id)
    return <Navigate to={`/samba/shares/${share.id}`} replace />;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{share.name}</h2>
          <p className="mt-1 text-sm text-gray-500">{share.comment}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Rename kind="share" object={share} disabled={!canWrite||!share.active||!snapshot.renameEnabled} confirm={confirm}/>
          <button
            className={button}
            disabled={!canWrite || share.external}
            onClick={() => edit(share)}
          >
            {share.active ? '编辑共享目录' : '恢复共享目录'}
          </button>
          {share.active && (
            <button
              className={button}
              disabled={!canWrite || share.external}
              onClick={() =>
                confirm('移除共享（保留目录和文件）', 'share.remove', {
                  name: share.name,
                })
              }
            >
              移除共享
            </button>
          )}
        </div>
      </div>
      {share.external && (
        <p className="text-sm text-gray-500">
          此共享沿用文件服务器现有配置。重命名共享不会移动原目录；路径和其他服务器配置继续受到保护。
        </p>
      )}
      <section className={card + ' p-5'}>
        <dl className="grid gap-5 sm:grid-cols-3">
          <Info label="发布状态">
            <Badge muted={!share.active}>
              {share.active ? '已发布' : '已移除（文件保留）'}
            </Badge>
          </Info>
          <Info label="访问模式">
            {share.read_only ? '共享只读' : '按目录权限'}
          </Info>
          <Info label="SMB 共享名称">{share.name}</Info>
          <Info label="相对存储路径">{share.path || share.name}</Info>
          <Info label="员工入口可见性">{share.browseable === false ? '隐藏共享' : '按用户权限显示'}</Info>
        </dl>
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">允许访问的用户组</h3>
        <p className="text-sm text-gray-500">
          访问组决定连接共享的资格；目录内能否读取、修改由 Windows 权限决定。
        </p>
        <DataTable
          label="目录访问组"
          rows={share.groups.map((name) => ({
            name,
            group: snapshot.groups.find((g) => g.name === name),
          }))}
          rowKey={(g) => g.name}
          searchText={(g) => g.name + ' ' + (g.group?.description || '')}
          actions={
            <button
              className={button}
              disabled={!canWrite || share.external}
              onClick={() => edit(share)}
            >
              调整访问组
            </button>
          }
          columns={[
            {
              label: '用户组',
              render: (g) =>
                g.group ? (
                  <Link className={link} to={`/samba/groups/${g.group.id}`}>
                    {g.name}
                  </Link>
                ) : (
                  g.name
                ),
            },
            {
              label: '说明',
              render: (g) => g.group?.description || '目录中未找到此组',
            },
            {
              label: '成员数量',
              render: (g) => g.group?.members.length ?? '—',
            },
          ]}
        />
      </section>
      {share.active && (
        <section className="space-y-3">
          <h3 className="font-semibold">目录与权限</h3>
          <div className="grid items-start gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside className={card + ' p-4'}>
              <nav
                aria-label="目录路径"
                className="mb-4 flex flex-wrap items-center gap-1 text-sm"
              >
                <button className={link} onClick={() => setPath('')}>
                  {share.name}
                </button>
                {path
                  .split('/')
                  .filter(Boolean)
                  .map((part, index, parts) => (
                    <span key={index} className="inline-flex gap-1">
                      <span>/</span>
                      <button
                        className={link}
                        onClick={() =>
                          setPath(parts.slice(0, index + 1).join('/'))
                        }
                      >
                        {part}
                      </button>
                    </span>
                  ))}
              </nav>
              <div className="mb-3 flex flex-wrap gap-2">
                {path && (
                  <button
                    className={button}
                    onClick={() =>
                      setPath(path.split('/').slice(0, -1).join('/'))
                    }
                  >
                    上级目录
                  </button>
                )}
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => void loadDirectory()}
                >
                  刷新目录
                </button>
              </div>
              <ul className="space-y-1">
                {directories.map((d) => (
                  <li key={d}>
                    <button
                      className="w-full rounded-lg px-3 py-3 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                      onClick={() => setPath(path ? path + '/' + d : d)}
                    >
                      <span aria-hidden className="mr-2">
                        📁
                      </span>
                      {d}
                    </button>
                  </li>
                ))}
              </ul>
              {busy ? (
                <p className="p-3 text-sm text-gray-500">加载目录与权限…</p>
              ) : (
                !directories.length && (
                  <p className="p-3 text-sm text-gray-500">没有子目录</p>
                )
              )}
              <div className="mt-4 space-y-2 border-t border-gray-100 pt-4 dark:border-gray-800">
                <button
                  className={button + ' w-full'}
                  disabled={!canWrite || busy}
                  onClick={() =>
                    open({
                      title: '新建目录',
                      action: 'directory.create',
                      fields: [
                        {
                          name: 'path',
                          label: '相对共享根目录的路径',
                          maxLength: 1024,
                        },
                      ],
                      values: { share: share.name, path: path ? path + '/' : '' },
                    })
                  }
                >
                  新建目录
                </button>
                {path && (
                  <button
                    className={button + ' w-full text-red-600'}
                    disabled={!canWrite || busy}
                    onClick={removeDirectory}
                  >
                    删除当前空目录
                  </button>
                )}
              </div>
            </aside>
            <div className="min-w-0 space-y-4">
              <div className={card + ' p-5'}>
                <h4 className="break-all font-semibold">
                  {share.name}/{path}
                </h4>
                <p className="mt-2 text-sm text-gray-500">
                  继承权限来自上级目录。移除直接授权后，其他组或继承权限仍可能生效。
                </p>
                {acl && (
                  <div className="mt-3 flex flex-wrap gap-3">
                    <Badge muted>
                      {acl.protected
                        ? '已阻止父目录权限继承'
                        : '继承父目录权限'}
                    </Badge>
                    <span className="text-xs text-gray-500">
                      所有者：{principalName(acl.owner)}
                    </span>
                  </div>
                )}
              </div>
              {acl && (
                <DataTable
                  label="Windows 目录权限"
                  rows={acl.entries.map((a, index) => ({
                    ...a,
                    key: String(index),
                  }))}
                  rowKey={(a) => a.key}
                  actions={
                    <>
                      <button
                        className={button}
                        disabled={!canWrite || !groupOptions.length}
                        onClick={() => grant(true)}
                      >
                        设置用户组权限
                      </button>
                      <button
                        className={button}
                        disabled={!canWrite || !userOptions.length}
                        onClick={() => grant(false)}
                      >
                        设置员工权限
                      </button>
                    </>
                  }
                  columns={[
                    {
                      label: '账号或组',
                      render: (a) => (
                        <span className="break-all">
                          {principalName(a.sid)}
                        </span>
                      ),
                    },
                    {
                      label: '类型',
                      render: (a) =>
                        a.effect === 'allow'
                          ? '允许'
                          : a.effect === 'deny'
                            ? '拒绝'
                            : '高级条目',
                    },
                    {
                      label: '权限',
                      render: (a) =>
                        a.mask === 0x1f01ff
                          ? '完全控制'
                          : a.mask === 0x1301bf
                            ? '修改'
                            : a.mask === 0x1200a9
                              ? '读取'
                              : a.mask !== undefined
                                ? `0x${a.mask.toString(16)}`
                                : a.details,
                    },
                    {
                      label: '应用范围',
                      render: (a) =>
                        a.inherited
                          ? '来自上级目录'
                          : a.inherit
                            ? '此目录及子目录与文件'
                            : '仅此目录',
                    },
                  ]}
                />
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
