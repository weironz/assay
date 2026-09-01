import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';
import { signOut } from '../lib/auth-client';
import Avatar from './Avatar';
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

/** lg 断点，与下面所有 lg: 类保持一致 */
const DESKTOP = '(min-width: 1024px)';

/** 汉堡图标。三条线是「打开导航」的通用符号，不需要再配文字 */
const MenuIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export default function AppLayout() {
  const { t } = useTranslation();
  const { user, has, clear } = useAuth();
  const navigate = useNavigate();

  // 默认展开——但只在桌面。手机上 256px 的侧栏会盖住整个内容区，
  // 所以窄屏默认收起，点汉堡按钮再以抽屉方式盖出来。
  const [open, setOpen] = useState(
    () => window.matchMedia(DESKTOP).matches,
  );

  // 跨越断点时重置：从手机转到桌面应该看得见导航，反之应该让开位置
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const sync = (e: MediaQueryListEvent) => setOpen(e.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  /** 手机上点导航后要收起抽屉，否则内容还被盖着 */
  const closeOnMobile = () => {
    if (!window.matchMedia(DESKTOP).matches) setOpen(false);
  };

  const logout = async () => {
    await signOut();
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* 手机抽屉展开时的遮罩，点击关闭。桌面不需要，侧栏是常驻的 */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          aria-hidden
        />
      )}

      {/* 左侧导航 */}
      {/* 256px 而非 240：品牌 lockup + 副标题在英文/泰语下装不进 240，见 BrandMark */}
      {/* 手机上是浮在内容之上的抽屉（fixed + 位移），桌面回到文档流里占位 */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0 dark:border-gray-800 dark:bg-gray-900 ${
          open ? 'translate-x-0' : '-translate-x-full lg:hidden'
        }`}
      >
        <div className="h-14 flex items-center px-4 border-b border-gray-200 dark:border-gray-800">
          <BrandMark />
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {MENU.filter((m) => !m.permission || has(m.permission)).map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              onClick={closeOnMobile}
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

        {/* 手机上顶栏放不下「退出登录」，挪到抽屉底部；桌面仍在顶栏，
            两处用 lg 断点互斥，不会同时出现 */}
        <div className="border-t border-gray-200 p-2 lg:hidden dark:border-gray-800">
          <button
            onClick={logout}
            className="w-full rounded-md px-3 py-2 text-left text-sm text-gray-600 hover:bg-gray-100 hover:text-red-600 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            {t('nav.signOut')}
          </button>
        </div>
      </aside>

      {/* 右侧主区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center gap-2 sm:gap-4 px-3 sm:px-6 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={t('nav.toggleSidebar')}
            title={t('nav.toggleSidebar')}
            className="-ml-1 shrink-0 rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            <MenuIcon />
          </button>
          {/* 抽屉收起时手机上就看不到品牌了，顶栏补一个只有图标的版本 */}
          <div className="min-w-0 lg:hidden">
            <BrandMark variant="mark" />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4">
            <LanguageSwitcher />
            <ThemeToggle />
            <NotificationBell />
            <NavLink
              to="/profile"
              className="flex items-center gap-2 text-sm text-gray-500 transition-colors hover:text-brand-700 dark:hover:text-brand-400"
              title={t('nav.profile')}
            >
              <Avatar
                name={user?.name}
                email={user?.email}
                image={user?.image}
                size={28}
              />
              {/* 窄屏只留头像，名字换来的宽度更值钱 */}
              <span className="hidden lg:inline">{user?.name}</span>
            </NavLink>
            <button
              onClick={logout}
              className="hidden whitespace-nowrap text-sm text-gray-600 hover:text-red-600 lg:block dark:text-gray-300"
            >
              {t('nav.signOut')}
            </button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
