import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { localeOf } from './index';

/**
 * Date/time formatters bound to the active UI language.
 *
 * Everything goes through Intl, so switching the language re-renders the
 * timestamps in that language's conventions without any per-page branching.
 */
export function useDateFormat() {
  const { i18n } = useTranslation();
  const locale = localeOf(i18n.language);

  return useMemo(
    () => ({
      /** Full date + time — detail views, notification rows, audit history */
      dateTime: (value: string | number | Date) =>
        new Date(value).toLocaleString(locale),
      /** Compact month/day + time — dense table cells */
      compact: (value: string | number | Date) =>
        new Date(value).toLocaleString(locale, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
    }),
    [locale],
  );
}
