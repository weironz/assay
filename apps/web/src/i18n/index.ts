import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import en from './locales/en';
import type { Resource } from './types';

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

// 非默认语言按需加载：动态 import 让每个语言包各自成为独立 chunk，
// 只有用户实际使用该语言时才下载（3/4 的翻译字符串不再进主包）。
// en 是默认语言兼回退语言，保持静态打包 —— 未选择过语言的用户零额外请求、零等待。
const LAZY_LOCALES: Record<string, () => Promise<{ default: Resource }>> = {
  'zh-CN': () => import('./locales/zh-CN'),
  'zh-TW': () => import('./locales/zh-TW'),
  th: () => import('./locales/th'),
};

async function ensureBundle(code: string) {
  const loader = LAZY_LOCALES[code];
  if (!loader || i18n.hasResourceBundle(code, 'translation')) return;
  const { default: messages } = await loader();
  i18n.addResourceBundle(code, 'translation', messages, true, true);
}

function configure() {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      // 只有 en 静态打包；其余语言包由 ensureBundle 在 init 前（首屏）或
      // 切换时（运行期）注入，partialBundledLanguages 允许 resources
      // 只覆盖 supportedLngs 的一部分。
      resources: {
        en: { translation: en },
      },
      supportedLngs: LANGUAGES.map((l) => l.code),
      fallbackLng: DEFAULT_LANGUAGE,
      partialBundledLanguages: true,
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
      // 活跃语言包总在 render 前就位（initI18n 门控），无需 Suspense
      react: { useSuspense: false },
    });
  syncDocument(i18n.language);
}

/**
 * 首屏引导：init 只带 en（partialBundledLanguages 允许其余语言缺席），
 * 再把已存储语言的包补上并 changeLanguage 刷新一次 —— addResourceBundle
 * 必须在 init 之后调用（资源仓库随 init 创建）。main.tsx 用本函数门控
 * 首次 render，渲染缺语言包的界面会闪现原始键名或回退英文。en 用户不
 * 产生任何请求（init 本身同步）。加载失败时静默回退 en，不阻断启动。
 */
export async function initI18n() {
  configure();
  const active = i18n.language;
  if (active && active !== DEFAULT_LANGUAGE && !i18n.hasResourceBundle(active, 'translation')) {
    try {
      await ensureBundle(active);
      // 同语言再 change 一次：触发语言事件重载，标题/<html lang> 与
      // 首帧渲染都拿到补齐后的资源
      await i18n.changeLanguage(active);
    } catch {
      // 语言包拉取失败（如断网）：留在 en 回退上，界面照常可用
    }
  }
  return i18n;
}

/** 切换语言：先确保语言包已加载再 changeLanguage（后者负责写回 localStorage） */
export async function setLanguage(code: string) {
  await ensureBundle(code);
  await i18n.changeLanguage(code);
}

/**
 * Keep <html lang> in step (screen readers, CSS :lang(), font fallback) and
 * translate the browser-tab title along with the UI.
 */
function syncDocument(lng: string) {
  document.documentElement.lang = localeOf(lng);
  document.title = `GreenStor COP · ${i18n.t('brand.subtitle')}`;
}

i18n.on('languageChanged', syncDocument);

/** BCP 47 tag for Intl APIs; falls back to the default language's tag */
export function localeOf(lng?: string): string {
  const code = lng ?? i18n.language;
  return (
    LANGUAGES.find((l) => l.code === code)?.locale ??
    LANGUAGES.find((l) => l.code === DEFAULT_LANGUAGE)!.locale
  );
}

export default i18n;
