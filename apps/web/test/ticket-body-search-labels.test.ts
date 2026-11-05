import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';
import en from '../src/i18n/locales/en';
import zhCN from '../src/i18n/locales/zh-CN';
import zhTW from '../src/i18n/locales/zh-TW';
import th from '../src/i18n/locales/th';

const resources = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, th };
const codes = Object.keys(resources) as Array<keyof typeof resources>;

async function createI18n() {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: Object.fromEntries(
      Object.entries(resources).map(([code, resource]) => [code, { translation: resource }]),
    ),
  });
  return i18n;
}

describe('issue #34 — titlePlaceholder advertises title + ticket no. + message body', () => {
  test('all four locales resolve a non-empty titlePlaceholder via i18next', async () => {
    const i18n = await createI18n();
    for (const code of codes) {
      await i18n.changeLanguage(code);
      const value = i18n.t('tickets.titlePlaceholder');
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  test('the four translations are pairwise distinct', () => {
    const values = codes.map((code) => resources[code].tickets.titlePlaceholder as string);
    expect(new Set(values).size).toBe(values.length);
  });

  test('each translation mentions the message-body (正文 / body / เนื้อหา) semantics', () => {
    const bodyMarkers: Record<string, string> = {
      en: 'body',
      'zh-CN': '正文',
      'zh-TW': '正文',
      th: 'เนื้อหา',
    };
    for (const code of codes) {
      const value = resources[code].tickets.titlePlaceholder as string;
      expect(value.includes(bodyMarkers[code])).toBe(true);
    }
  });

  test('other keys remain intact: ticketDetail.imagePreview and common.close are non-empty', async () => {
    const i18n = await createI18n();
    for (const code of codes) {
      await i18n.changeLanguage(code);
      for (const key of ['ticketDetail.imagePreview', 'common.close']) {
        const value = i18n.t(key);
        expect(typeof value).toBe('string');
        expect((value as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('top-level resource key sets are identical across the four locales', () => {
    const signatures = codes.map((code) => Object.keys(resources[code]).sort().join('|'));
    expect(new Set(signatures).size).toBe(1);
  });
});
