import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';
import { createDateFormatters } from '../src/i18n/format';
import { LANGUAGES, localeOf } from '../src/i18n';
import en from '../src/i18n/locales/en';
import zhCN from '../src/i18n/locales/zh-CN';
import zhTW from '../src/i18n/locales/zh-TW';
import th from '../src/i18n/locales/th';

// Local-noon Date constructors keep the calendar year stable on any machine:
// toLocaleString formats in that same local zone, so no UTC offset can roll
// 2025-12-31 into 2026 (or vice versa) and break the year assertions.
const END_OF_2025 = new Date(2025, 11, 31, 12, 5, 0);
const START_OF_2026 = new Date(2026, 0, 1, 12, 5, 0);
// Same month/day/time, different years — previously rendered identically.
const SAME_DAY_2025 = new Date(2025, 0, 15, 12, 5, 0);
const SAME_DAY_2026 = new Date(2026, 0, 15, 12, 5, 0);

const resources = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, th };

// Mirrors ticket-attributes.test.js: a standalone i18next instance initialised
// with all four bundles, then switched to the language under test. Walking the
// real code -> BCP 47 -> Intl chain also proves Thai keeps its forced
// Gregorian calendar (th-TH-u-ca-gregory), so years read 2025/2026 not 2568/2569.
async function formattersFor(code: string) {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: Object.fromEntries(
      Object.entries(resources).map(([c, r]) => [c, { translation: r }]),
    ),
  });
  await i18n.changeLanguage(code);
  const locale = localeOf(i18n.language);
  expect(locale).toBe(LANGUAGES.find((l) => l.code === code)!.locale);
  return createDateFormatters(locale);
}

for (const code of Object.keys(resources)) {
  describe(`compact / dateTime — ${code}`, () => {
    test('compact includes the Gregorian year across 2025/2026', async () => {
      const { compact } = await formattersFor(code);
      // Only the year substring is asserted: the surrounding order/separators
      // are locale-specific and must not be hard-coded here.
      expect(compact(END_OF_2025)).toContain('2025');
      expect(compact(START_OF_2026)).toContain('2026');
      // Guard the forced-Gregorian setting: Thai must never show Buddhist years.
      expect(compact(END_OF_2025)).not.toContain('2568');
      expect(compact(START_OF_2026)).not.toContain('2569');
    });

    test('same month/day in different years no longer renders identically', async () => {
      const { compact } = await formattersFor(code);
      expect(compact(SAME_DAY_2025)).not.toBe(compact(SAME_DAY_2026));
    });

    test('dateTime regression guard: still carries the year and distinguishes the two dates', async () => {
      const { dateTime } = await formattersFor(code);
      expect(dateTime(END_OF_2025)).toContain('2025');
      expect(dateTime(START_OF_2026)).toContain('2026');
      expect(dateTime(END_OF_2025)).not.toBe(dateTime(START_OF_2026));
    });
  });
}
