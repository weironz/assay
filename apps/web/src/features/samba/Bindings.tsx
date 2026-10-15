import { Link } from 'react-router-dom';
import { DataTable, button, card, link, primary } from './components';
import { employeeLabel, type Workspace } from './types';

export function Bindings({
  snapshot,
  canWrite,
  open,
  unlink,
}: Workspace & { unlink: (userId: string) => void }) {
  const userOptions = snapshot.users
    .filter((u) => u.manageable !== false && !u.disabled)
    .map((u) => ({ value: u.id, label: employeeLabel(u) }));
  return (
    <>
      <section className={card + ' p-6'}>
        <h2 className="font-semibold">为什么需要关联？</h2>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium">Assay 登录账号</h3>
            <p className="mt-2 text-sm text-gray-500">
              用于登录
              Web、操作工单、资产等业务；业务角色在“系统账号与角色”中管理。
            </p>
          </div>
          <div>
            <h3 className="text-sm font-medium">公司 AD 员工账号</h3>
            <p className="mt-2 text-sm text-gray-500">
              用于文件共享和公司目录认证；文件权限通过用户组和目录 ACL 管理。
            </p>
          </div>
        </div>
        <p className="mt-4 border-t border-gray-100 pt-4 text-sm text-gray-500 dark:border-gray-800">
          本地登录和公司 AD 登录均可选。启用 AD 登录后，员工首次登录可自动建立业务账号并关联文件身份；已有业务账号应由管理员在此明确关联，以保留工单和库存历史。关联本身不会同步密码。业务角色可在“平台管理 → 身份与访问”映射 AD 用户组。
        </p>
      </section>
      <DataTable
        label="登录账号关联"
        rows={snapshot.bindings}
        rowKey={(b) => b.userId}
        searchText={(b) =>
          b.accountName +
          ' ' +
          (snapshot.assayUsers.find((u) => u.id === b.userId)?.email || '')
        }
        actions={
          <button
            className={primary}
            disabled={
              !canWrite || !userOptions.length || !snapshot.assayUsers.length
            }
            onClick={() =>
              open({
                title: '关联员工登录账号',
                action: '',
                endpoint: '/samba/bindings',
                fields: [
                  {
                    name: 'userId',
                    label: 'Assay 用户',
                    type: 'select',
                    options: snapshot.assayUsers.map((u) => ({
                      value: u.id,
                      label: `${u.name} · ${u.email}`,
                    })),
                  },
                  {
                    name: 'adObjectId',
                    label: 'AD 员工账号',
                    type: 'select',
                    options: userOptions,
                  },
                ],
                values: {
                  userId: snapshot.assayUsers[0]?.id || '',
                  adObjectId: userOptions[0]?.value || '',
                },
              })
            }
          >
            关联账号
          </button>
        }
        columns={[
          {
            label: 'Assay 用户',
            render: (b) => (
              <div>
                {snapshot.assayUsers.find((u) => u.id === b.userId)?.name ||
                  '已停用或已删除用户'}
                <p className="mt-1 text-xs text-gray-500">
                  {snapshot.assayUsers.find((u) => u.id === b.userId)?.email}
                </p>
              </div>
            ),
          },
          {
            label: '公司 AD 账号',
            render: (b) => (
              <Link className={link} to={`/samba/users/${b.adObjectId}`}>
                {b.accountName}
              </Link>
            ),
          },
          {
            label: '操作',
            render: (b) => (
              <button
                className={button}
                disabled={!canWrite || b.directoryManaged}
                title={b.directoryManaged ? '此关联用于 AD 统一登录，不能直接解除' : undefined}
                onClick={() => unlink(b.userId)}
              >
                解除关联
              </button>
            ),
          },
        ]}
      />
    </>
  );
}
