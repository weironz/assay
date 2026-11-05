import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { localeOf } from './index';

/**
 * Pure formatter factory. The Intl logic lives outside the hook so the
 * year-in-compact behaviour can be asserted in a plain bun:test without
 * rendering a React component. `useDateFormat` keeps the exact same
 * `{ dateTime, compact }` public shape; it is now just a thin wrapper that
 * binds the active locale and memoises the result.
 */
export function createDateFormatters(locale: string) {
  return {
    /** Full date + time — detail views, notification rows, audit history */
    dateTime: (value: string | number | Date) =>
      new Date(value).toLocaleString(locale),
    /** Compact date + time — dense table cells. The year is required so
     * tickets created in different years (e.g. 2025 vs 2026) stay
     * distinguishable; without it they collapse to the same string. */
    compact: (value: string | number | Date) =>
      new Date(value).toLocaleString(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
  };
}

/**
 * Date/time formatters bound to the active UI language.
 *
 * Everything goes through Intl, so switching the language re-renders the
 * timestamps in that language's conventions without any per-page branching.
 */
export function useDateFormat() {
  const { i18n } = useTranslation();
  const locale = localeOf(i18n.language);

  return useMemo(() => createDateFormatters(locale), [locale]);
}
