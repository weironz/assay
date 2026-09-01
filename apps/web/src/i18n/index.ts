import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import en from './locales/en';
import zhCN from './locales/zh-CN';
import zhTW from './locales/zh-TW';
import th from './locales/th';

export interface LanguageOption {
  /** i18next language code, also what lands in localStorage */
  code: string;
  /** Endonym — a language is always listed in its own script */
  label: string;
  /** BCP 47 tag handed to Intl / toLocaleString */
  locale: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'en', label: 'English', locale: 'en' },
  { code: 'zh-CN', label: '简体中文', locale: 'zh-CN' },
  { code: 'zh-TW', label: '繁體中文', locale: 'zh-TW' },
  // 强制公历：泰语默认走佛历，2026 会显示成 2569，而工单号本身是
  // WO-20260709-0002 这种公历编号，两者并排会直接打架；跨语言协作时
  // 大家讨论的也该是同一个日期。想恢复泰国本地习惯就改回 'th-TH'。
  { code: 'th', label: 'ไทย', locale: 'th-TH-u-ca-gregory' },
];

export const DEFAULT_LANGUAGE = 'en';

const STORAGE_KEY = 'i18nextLng';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
      'zh-TW': { translation: zhTW },
      th: { translation: th },
    },
    supportedLngs: LANGUAGES.map((l) => l.code),
    fallbackLng: DEFAULT_LANGUAGE,
    // 'zh-CN' must stay 'zh-CN' — never be folded into a bare 'zh' bundle
    load: 'currentOnly',
    nonExplicitSupportedLngs: false,
    detection: {
      // Deliberately NOT 'navigator': the product spec is "English until the
      // user picks otherwise", so only a stored choice overrides the default.
      order: ['localStorage'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    // React escapes for us; double-escaping would render literal &#39; etc.
    interpolation: { escapeValue: false },
    // Resources are bundled, so init is synchronous and no Suspense is needed
    initAsync: false,
    react: { useSuspense: false },
  });

/**
 * Keep <html lang> in step (screen readers, CSS :lang(), font fallback) and
 * translate the browser-tab title along with the UI.
 */
function syncDocument(lng: string) {
  document.documentElement.lang = localeOf(lng);
  document.title = `Greenstor ${i18n.t('brand.subtitle')}`;
}

i18n.on('languageChanged', syncDocument);
syncDocument(i18n.language);

/** BCP 47 tag for Intl APIs; falls back to the default language's tag */
export function localeOf(lng?: string): string {
  const code = lng ?? i18n.language;
  return (
    LANGUAGES.find((l) => l.code === code)?.locale ??
    LANGUAGES.find((l) => l.code === DEFAULT_LANGUAGE)!.locale
  );
}

export default i18n;
