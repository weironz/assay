import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/** Portals keep menus outside the table's horizontal clipping area. */
export default function ColumnFilter({
  label,
  active,
  onClear,
  children,
}: {
  label: string;
  active: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current?.getClientRects().length) {
        setOpen(false);
        return;
      }
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(288, window.innerWidth - 24);
      const height = panel.current?.offsetHeight || 240;
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: Math.max(
          12,
          Math.min(rect.bottom + 6, window.innerHeight - height - 12),
        ),
      });
    };
    place();
    panel.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span>{label}</span>
      <button
        ref={trigger}
        type="button"
        aria-label={t('ticketUi.filter', { column: label })}
        title={t('ticketUi.filter', { column: label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-brand-500 ${active ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
      >
        <svg
          aria-hidden="true"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill={active ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={t('ticketUi.filter', { column: label })}
            onBlur={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                event.relatedTarget !== trigger.current
              )
                setOpen(false);
            }}
            style={{
              position: 'fixed',
              ...position,
              width: 'min(18rem, calc(100vw - 24px))',
            }}
            className="z-[70] max-h-[calc(100dvh-24px)] space-y-3 overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 text-left text-sm font-normal text-gray-900 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <p className="font-medium">{label}</p>
            {children}
            <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-3 dark:border-gray-800">
              <button
                type="button"
                className="min-h-11 rounded px-2 text-gray-500 focus-visible:ring-2 focus-visible:ring-brand-500"
                onClick={() => {
                  onClear();
                  close();
                }}
              >
                {t('ticketUi.clear')}
              </button>
              <button
                type="button"
                className="min-h-11 rounded bg-brand-700 px-3 text-white focus-visible:ring-2 focus-visible:ring-brand-500"
                onClick={close}
              >
                {t('ticketUi.done')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
