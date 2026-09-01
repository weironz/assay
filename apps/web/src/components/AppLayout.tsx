import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';
import { signOut } from '../lib/auth-client';
import { absUrl } from '../lib/api';
import BrandMark from './BrandMark';
import NotificationBell from './NotificationBell';
import ThemeToggle from './ThemeToggle';
import LanguageSwitcher from './LanguageSwitcher';

interface MenuItem {
  to: string;
  /** i18n key, resolved at render so the sidebar follows the active language */
  labelKey: string;
  permission?: string;
}

const MENU: MenuItem[] = [
  { to: '/dashboard', labelKey: 'nav.dashboard' },
  { to: '/tickets', labelKey: 'nav.tickets' },
  { to: '/users', labelKey: 'nav.users', permission: 'user:manage' },
  { to: '/queues', labelKey: 'nav.queues', permission: 'queue:manage' },
];

export default function AppLayout() {
  const { t } = useTranslation();
  const { user, has, clear } = useAuth();
  const navigate = useNavigate();

  const logout = async () => {
    await signOut();
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* 左侧导航 */}
      <aside className="w-60 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-gray-200 dark:border-gray-800">
          <BrandMark />
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {MENU.filter((m) => !m.permission || has(m.permission)).map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              className={({ isActive }) =>
                // 选中态用「品牌绿竖条 + 淡绿底」而不是整块实心：
                // 侧栏里大块饱和色会和主区内容抢注意力，细指示条足够表明位置
                `relative block rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-950/60 dark:text-brand-300'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-brand-500" />
                  )}
                  {t(m.labelKey)}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* 右侧主区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center justify-end gap-4 px-6 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <LanguageSwitcher />
          <ThemeToggle />
          <NotificationBell />
          <NavLink
            to="/profile"
            className="flex items-center gap-2 text-sm text-gray-500 transition-colors hover:text-brand-700 dark:hover:text-brand-400"
            title={t('nav.profile')}
          >
            {user?.image ? (
              <img
                src={absUrl(user.image)}
                alt=""
                className="w-7 h-7 rounded-full object-cover border border-gray-200 dark:border-gray-700"
              />
            ) : (
              <span className="w-7 h-7 rounded-full bg-brand-600 text-white flex items-center justify-center text-xs font-medium">
                {(user?.name || user?.email || '?').slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>
              {user?.name}
              <span className="ml-2 text-xs text-gray-400">
                [{user?.roles.join(', ')}]
              </span>
            </span>
          </NavLink>
          <button
            onClick={logout}
            className="text-sm text-gray-600 dark:text-gray-300 hover:text-red-600"
          >
            {t('nav.signOut')}
          </button>
        </header>
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
