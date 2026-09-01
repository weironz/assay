import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A user-facing message held in state.
 *
 * Storing the *key* rather than the rendered string is what makes banners
 * ("password reset", "email or password incorrect") follow a mid-flow language
 * switch. `raw` is the escape hatch for text that only the server can produce
 * — it is passed through untranslated rather than being dropped.
 */
export type Msg =
  | { key: string; params?: Record<string, unknown> }
  | { raw: string }
  | null;

export function useMsg() {
  const { t } = useTranslation();
  return useCallback(
    (m: Msg): string => {
      if (!m) return '';
      return 'raw' in m ? m.raw : t(m.key, m.params ?? {});
    },
    [t],
  );
}
