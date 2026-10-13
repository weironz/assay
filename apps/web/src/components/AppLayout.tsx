import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';
import { signOut } from '../lib/auth-client';
import {
  BUSINESS_MODULES,
  PLATFORM_MODULE,
  allowedItems,
  moduleForPath,
  activeMenuItem,
  menuHref,
  type MenuItem,
} from '../lib/business-navigation';
import AccountMenu from './AccountMenu';
import BrandMark from './BrandMark';
import NotificationBell from './NotificationBell';
import ThemeToggle from './ThemeToggle';
import LanguageSwitcher from './LanguageSwitcher';

const DESKTOP = '(min-width: 1024px)';
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
  const { has, clear } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const modules = BUSINESS_MODULES.filter(
    (module) => allowedItems(module.items, has).length > 0,
  );
  const requestedModule = moduleForPath(location.pathname);
  const platformItems = allowedItems(PLATFORM_MODULE.items, has);
  const currentModule =
    requestedModule?.id === PLATFORM_MODULE.id && platformItems.length
      ? PLATFORM_MODULE
      : modules.find((module) => module.id === requestedModule?.id);
  const moduleItems = currentModule
    ? allowedItems(currentModule.items, has)
    : [];
  const activeItem = activeMenuItem(moduleItems, location.pathname, params);
  const [open, setOpen] = useState(() => window.matchMedia(DESKTOP).matches);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const sync = (event: MediaQueryListEvent) => setOpen(event.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  // Also close on route changes caused by notifications, browser history or deep links.
  useEffect(() => {
    if (!window.matchMedia(DESKTOP).matches) setOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open || window.matchMedia(DESKTOP).matches) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  const logout = async () => {
    await signOut();
    clear();
    navigate('/login', { replace: true });
  };
  const closeOnMobile = () => {
    if (!window.matchMedia(DESKTOP).matches) setOpen(false);
  };
  const moduleLinks = () =>
    modules.map((module) => (
      <Link
        key={module.id}
        to={allowedItems(module.items, has)[0].to}
        onClick={closeOnMobile}
        aria-current={currentModule?.id === module.id ? 'page' : undefined}
        className={`flex min-h-12 shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors xl:px-4 ${
          currentModule?.id === module.id
            ? 'border-brand-500 text-brand-800 dark:text-brand-300'
            : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
        }`}
      >
        {t(module.labelKey)}
      </Link>
    ));
  const sidebarLink = (item: MenuItem) => {
    const active = activeItem === item.to;
    return (
      <Link
        key={item.to}
        to={menuHref(item, location.pathname, params)}
        onClick={closeOnMobile}
        aria-current={active ? 'page' : undefined}
        className={`relative block rounded-md px-3 py-2.5 text-sm transition-colors ${
          active
            ? 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-950/60 dark:text-brand-300'
            : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
        }`}
      >
        {active && (
          <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-full bg-brand-500" />
        )}
        {t(item.labelKey)}
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-50 shrink-0 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="flex h-14 items-center gap-2 px-3 sm:gap-4 sm:px-5">
          {currentModule ? (
            <button
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-controls="workspace-sidebar"
              aria-label={t('nav.toggleSidebar')}
              title={t('nav.toggleSidebar')}
              className="shrink-0 rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            >
              <MenuIcon />
            </button>
          ) : (
            <span className="w-9 shrink-0" aria-hidden />
          )}
          <div className="hidden min-w-0 shrink-0 sm:block lg:max-w-60">
            <BrandMark />
          </div>
          <div className="shrink-0 sm:hidden">
            <BrandMark variant="mark" />
          </div>
          <nav
            aria-label={t('nav.businessModules')}
            className="ml-3 hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:flex"
          >
            {moduleLinks()}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
            <LanguageSwitcher />
            <ThemeToggle />
            <NotificationBell />
            {platformItems.length > 0 && (
              <Link
                to={platformItems[0].to}
                onClick={closeOnMobile}
                aria-label={t('nav.platformManagement')}
                title={t('nav.platformManagement')}
                aria-current={
                  currentModule?.id === 'platform' ? 'page' : undefined
                }
                className={`flex items-center gap-1.5 rounded-md p-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  currentModule?.id === 'platform'
                    ? 'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-300'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-brand-700 dark:hover:bg-gray-800 dark:hover:text-brand-400'
                }`}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M10 2h4l.5 3.2 2.1 1.2 3-1.1 2 3.4-2.5 2v2.6l2.5 2-2 3.4-3-1.1-2.1 1.2L14 22h-4l-.5-3.2-2.1-1.2-3 1.1-2-3.4 2.5-2v-2.6l-2.5-2 2-3.4 3 1.1 2.1-1.2Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span className="hidden xl:inline">
                  {t('nav.platformManagement')}
                </span>
              </Link>
            )}
            <AccountMenu onLogout={logout} />
          </div>
        </div>
        <nav
          aria-label={t('nav.businessModules')}
          className="flex h-14 items-stretch gap-1 overflow-x-auto px-3 lg:hidden"
        >
          {moduleLinks()}
        </nav>
      </header>
      <div className="flex min-w-0 flex-1">
        {currentModule && open && (
          <div
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            aria-hidden
          />
        )}
        {currentModule && (
          <aside
            id="workspace-sidebar"
            aria-label={t('nav.moduleMenu')}
            className={`fixed bottom-0 left-0 top-28 z-40 flex w-60 shrink-0 flex-col border-r border-gray-200 bg-white transition-transform duration-200 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:self-start lg:translate-x-0 dark:border-gray-800 dark:bg-gray-900 ${open ? 'translate-x-0' : '-translate-x-full lg:hidden'}`}
          >
            <h2 className="border-b border-gray-100 px-5 py-4 text-sm font-semibold dark:border-gray-800">
              {t(currentModule.labelKey)}
            </h2>
            <div className="flex-1 overflow-y-auto p-3">
              <nav aria-label={t(currentModule.labelKey)} className="space-y-1">
                {moduleItems.map(sidebarLink)}
              </nav>
            </div>
          </aside>
        )}
        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
