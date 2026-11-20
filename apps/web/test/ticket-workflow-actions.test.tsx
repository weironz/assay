import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import TicketWorkflowActions from '../src/components/TicketWorkflowActions';
import en from '../src/i18n/locales/en';
import zhCN from '../src/i18n/locales/zh-CN';
import zhTW from '../src/i18n/locales/zh-TW';
import th from '../src/i18n/locales/th';

const resources = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, th };
async function render(code: keyof typeof resources, error: unknown, isPending = false) {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: code, resources: { [code]: { translation: resources[code] } } });
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>
    <TicketWorkflowActions actions={['resume', 'resolve']} pendingAction="resume" isPending={isPending} error={error} onAction={() => {}} />
  </I18nextProvider>);
}

describe('ticket status actions provide visible, localized feedback', () => {
  for (const code of Object.keys(resources) as Array<keyof typeof resources>) {
    test(`${code}: network/server errors are announced without exposing database internals`, async () => {
      for (const error of [new Error('Network Error'), { response: { status: 500, data: { message: 'Prisma: customer-private-data' } } }]) {
        const html = await render(code, error);
        expect(html).toContain('role="alert"');
        expect(html).toContain(resources[code].ticketDetail.actionFailed);
        expect(html).not.toContain('customer-private-data');
      }
    });
    test(`${code}: permission and stale state errors give specific guidance`, async () => {
      expect(await render(code, { response: { status: 403 } })).toContain(resources[code].ticketDetail.actionForbidden);
      expect(await render(code, { response: { status: 409 } })).toContain(resources[code].ticketDetail.actionConflict);
    });
  }
  test('pending disables all actions and marks only the clicked action busy; retry clears the old alert', async () => {
    const html = await render('zh-CN', new Error('old failure'), true);
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html.match(/aria-busy="true"/g)?.length).toBe(1);
    expect(html).toContain('恢复处理中…');
    expect(html).not.toContain('role="alert"');
  });
  test('successful state has enabled actions and no error alert', async () => {
    const html = await render('en', null);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('role="alert"');
  });
});
