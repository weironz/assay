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
  { code: 'th', label: 'ไทย', locale: 'th-TH' },
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

/** Keep <html lang> in step so screen readers and CSS :lang() stay correct */
function syncDocumentLang(lng: string) {
  document.documentElement.lang = localeOf(lng);
}

i18n.on('languageChanged', syncDocumentLang);
syncDocumentLang(i18n.language);

/** BCP 47 tag for Intl APIs; falls back to the default language's tag */
export function localeOf(lng?: string): string {
  const code = lng ?? i18n.language;
  return (
    LANGUAGES.find((l) => l.code === code)?.locale ??
    LANGUAGES.find((l) => l.code === DEFAULT_LANGUAGE)!.locale
  );
}

export default i18n;
