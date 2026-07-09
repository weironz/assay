import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { signOut } from '../lib/auth-client';
import NotificationBell from './NotificationBell';
import ThemeToggle from './ThemeToggle';
import ChangePasswordModal from './ChangePasswordModal';

interface MenuItem {
  to: string;
  label: string;
  permission?: string;
}

const MENU: MenuItem[] = [
  { to: '/dashboard', label: '仪表盘' },
  { to: '/tickets', label: '工单' },
  { to: '/users', label: '用户管理', permission: 'user:manage' },
  { to: '/queues', label: '队列管理', permission: 'queue:manage' },
];

export default function AppLayout() {
  const { user, has, clear } = useAuth();
  const navigate = useNavigate();
  const [showPwd, setShowPwd] = useState(false);

  const logout = async () => {
    await signOut();
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* 左侧导航 */}
      <aside className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="h-14 flex items-center px-4 font-semibold border-b border-gray-200 dark:border-gray-800">
          工单管理系统
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {MENU.filter((m) => !m.permission || has(m.permission)).map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                }`
              }
            >
              {m.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* 右侧主区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center justify-end gap-4 px-6 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <ThemeToggle />
          <NotificationBell />
          <span className="text-sm text-gray-500">
            {user?.name}
            <span className="ml-2 text-xs text-gray-400">
              [{user?.roles.join(', ')}]
            </span>
          </span>
          <button
            onClick={() => setShowPwd(true)}
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-blue-600"
          >
            修改密码
          </button>
          <button
            onClick={logout}
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-red-600"
          >
            退出登录
          </button>
        </header>
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
      {showPwd && <ChangePasswordModal onClose={() => setShowPwd(false)} />}
    </div>
  );
}
