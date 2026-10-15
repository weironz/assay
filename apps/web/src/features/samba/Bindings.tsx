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
          当前两者独立，关联不会同步密码、自动创建账号或修改角色。员工关联后可在“个人设置
          → 安全”自助修改 AD 密码；启用“我的文件”后，也可验证本人 AD 密码访问文件。以后若启用由 AD 提供身份的 OIDC
          登录，可使用公司身份登录 Assay；Assay 业务权限仍由业务角色控制。
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
                disabled={!canWrite}
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
