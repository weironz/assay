import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, DEFAULT_LANGUAGE } from '../i18n';

/**
 * Language picker — a neutral, low-weight auxiliary control.
 *
 * Per the project's colour discipline (colour marks "things needing
 * attention"), the trigger stays grey in every state; brand green appears
 * only as the tick on the current language. Sizing matches the other header
 * utilities (theme toggle, bell) so it never competes with the primary work
 * area.
 *
 * Interaction follows the ARIA listbox pattern: the button owns
 * aria-haspopup/expanded, the popup is a real listbox driven by
 * aria-activedescendant, and focus returns to the button on close.
 */
export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const currentIndex = Math.max(
    0,
    LANGUAGES.findIndex((l) => l.code === i18n.language),
  );
  const current = LANGUAGES[currentIndex] ?? LANGUAGES[0];
  const optionId = (i: number) => `${listId}-opt-${LANGUAGES[i].code}`;

  // Move DOM focus onto the listbox when it opens so arrow keys land there
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const openList = (index = currentIndex) => {
    setActive(index);
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const choose = (index: number) => {
    const code = LANGUAGES[index]?.code ?? DEFAULT_LANGUAGE;
    void i18n.changeLanguage(code);
    close();
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openList(e.key === 'ArrowDown' ? currentIndex : LANGUAGES.length - 1);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => (i + 1) % LANGUAGES.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => (i - 1 + LANGUAGES.length) % LANGUAGES.length);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(LANGUAGES.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t('language.select')}
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
      >
        <GlobeIcon />
        <span className="whitespace-nowrap">{current.label}</span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <>
          {/* click-outside catcher, same pattern as NotificationBell */}
          <div className="fixed inset-0 z-10" onClick={() => close(false)} />
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={t('language.label')}
            aria-activedescendant={optionId(active)}
            onKeyDown={onListKeyDown}
            className="absolute right-0 z-20 mt-1 max-w-[calc(100vw-2rem)] min-w-[10rem] overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg outline-none dark:border-gray-700 dark:bg-gray-900"
          >
            {LANGUAGES.map((lang, i) => {
              const selected = i === currentIndex;
              return (
                <li
                  key={lang.code}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  lang={lang.locale}
                  onClick={() => choose(i)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs whitespace-nowrap ${
                    i === active ? 'bg-gray-100 dark:bg-gray-800' : ''
                  } ${
                    selected
                      ? 'font-medium text-brand-700 dark:text-brand-400'
                      : 'text-gray-700 dark:text-gray-300'
                  }`}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    {selected && <CheckIcon />}
                  </span>
                  {lang.label}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/* Inline SVGs: they inherit currentColor, scale crisply and stay identical
   across platforms — unlike the 🌐 emoji, which each OS renders differently. */

function GlobeIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${
        open ? 'rotate-180' : ''
      }`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
