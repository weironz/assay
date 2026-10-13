import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';
import Avatar from './Avatar';

export default function AccountMenu({
  onLogout,
}: {
  onLogout: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const user = useAuth((state) => state.user);
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  const itemClass =
    'block w-full rounded-md px-3 py-2.5 text-left text-sm text-gray-700 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:text-gray-300 dark:hover:bg-gray-800 dark:focus:bg-gray-800';

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    (focusLast.current ? items.at(-1) : items[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const keydown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
            items.length;
    items[next].focus();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('nav.accountMenu')}
        title={t('nav.accountMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          focusLast.current = false;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusLast.current = event.key === 'ArrowUp';
            setOpen(true);
          }
        }}
        className="flex items-center gap-1 rounded-md p-1 text-sm text-gray-500 hover:bg-gray-100 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-gray-800 dark:hover:text-brand-400"
      >
        <Avatar
          name={user?.name}
          email={user?.email}
          image={user?.image}
          size={28}
        />
        <span className="hidden xl:inline">{user?.name}</span>
        <svg
          className="hidden sm:block"
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={t('nav.accountMenu')}
          onKeyDown={keydown}
          className="absolute right-0 top-full z-20 mt-2 w-64 max-w-[calc(100vw-1.5rem)] rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="mb-1 border-b border-gray-100 px-3 py-2 dark:border-gray-800">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-gray-500">{user?.email}</p>
          </div>
          <Link
            role="menuitem"
            className={itemClass}
            to="/settings"
            onClick={() => setOpen(false)}
          >
            {t('nav.personalSettings')}
          </Link>
          <Link
            role="menuitem"
            className={itemClass}
            to="/settings?tab=security"
            onClick={() => setOpen(false)}
          >
            {t('nav.securitySettings')}
          </Link>
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <button
            role="menuitem"
            type="button"
            className={itemClass + ' hover:text-red-600'}
            onClick={async () => {
              setOpen(false);
              await onLogout();
            }}
          >
            {t('nav.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
