import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { api } from '../lib/api';
import { displayDomain, type Snapshot } from '../features/samba/types';
import { Badge, card, link } from '../features/samba/components';

export default function AdministrationPage({ directoryMode = false }: { directoryMode?: boolean }) {
  const { has } = useAuth();
  const [directory, setDirectory] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const readDirectory = directoryMode && has('samba:read');
  useEffect(() => {
    if (readDirectory)
      void api
        .get('/samba/snapshot')
        .then((r) => setDirectory(r.data))
        .catch(() =>
          setError('公司目录暂时无法连接，请在员工账号页面刷新重试。'),
        );
  }, [readDirectory]);
  const sections = [
    {
      title: '文件管理',
      description: '管理公司 AD 员工资料、用户组和文件访问权限。',
      items: [
        {
          to: '/samba/users',
          title: '员工账号',
          description: '工号、邮箱、岗位、部门与账号状态',
          permission: 'samba:read',
          count: directory?.users?.length,
        },
        {
          to: '/samba/groups',
          title: '用户组',
          description: '团队成员和批量成员管理',
          permission: 'samba:read',
          count: directory?.groups?.length,
        },
        {
          to: '/samba/shares',
          title: '共享目录',
          description: '访问用户组、子目录与 Windows 权限',
          permission: 'samba:read',
          count: directory?.shares?.filter((s) => s.active).length,
        },
      ],
    },
    {
      title: directoryMode ? '登录账号关联' : '平台组织与访问',
      description: directoryMode ? '明确员工的 Assay 登录身份与 AD 文件访问身份。' : '管理 Assay 业务组织、系统账号和业务角色。',
      items: [
        { to: '/directory-settings', title: '身份与访问', description: '可选公司登录、AD 用户组与业务角色映射', permission: 'user:manage', count: undefined },
        {
          to: '/organization',
          title: '组织架构',
          description: '业务部门及人员归属',
          permission: 'organization:manage',
          count: undefined,
        },
        {
          to: '/users',
          title: '系统账号与角色',
          description: 'Assay 登录账号及业务操作权限',
          permission: 'user:manage',
          count: undefined,
        },
        {
          to: '/samba/bindings',
          title: '登录账号关联',
          description: '关联公司 AD 账号，支持自助改密和员工文件验证',
          permission: 'samba:read',
          count: directory?.bindings?.length,
        },
      ],
    },
    {
      title: '管理审计',
      description: '核对公司目录变更与执行结果。',
      items: [
        {
          to: '/samba/history',
          title: '目录操作记录',
          description: '账号、成员、目录与权限变更记录',
          permission: 'samba:read',
          count: undefined,
        },
      ],
    },
  ];
  return (
    <div className="mx-auto max-w-[1500px] space-y-8">
      <div>
        <p className="mb-2 text-sm text-gray-500">{directoryMode ? '文件管理' : '平台管理'}</p>
        <h1 className="text-2xl font-semibold tracking-tight">管理概览</h1>
        <p className="mt-2 text-sm text-gray-500">
          {directoryMode ? '管理员工资料、用户组、账号关联及文件访问权限。员工可从同一模块的“共享文件”访问获授权的目录。' : '管理 Assay 的组织架构、系统账号和业务角色。'}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {directory?.enabled && (
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <Badge>{displayDomain(directory.domain)}</Badge>
          <span>
            {directory.readOnly ? '公司目录只读模式' : '公司目录已连接'}
          </span>
        </div>
      )}
      {sections.map((section) => {
        const items = section.items.filter((i) => has(i.permission) && i.to.startsWith('/samba') === directoryMode);
        return items.length ? (
          <section key={section.title}>
            <h2 className="font-semibold">{section.title}</h2>
            <p className="mb-4 mt-1 text-sm text-gray-500">
              {section.description}
            </p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={
                    card +
                    ' group p-6 transition hover:border-brand-400 dark:hover:border-brand-600'
                  }
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">{item.title}</h3>
                    {item.count !== undefined && (
                      <Badge muted>{item.count}</Badge>
                    )}
                  </div>
                  <p className="mt-3 text-sm text-gray-500">
                    {item.description}
                  </p>
                  <span className={link + ' mt-5 inline-block text-sm'}>
                    进入管理 →
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null;
      })}
    </div>
  );
}
