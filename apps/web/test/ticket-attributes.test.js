import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';
import { attributeDraft, attributePatch, canEditAttributes, CUSTOM_CATEGORY } from '../src/lib/ticket-attributes';
import { metadataLabel } from '../src/lib/metadata-labels';
import en from '../src/i18n/locales/en';
import zhCN from '../src/i18n/locales/zh-CN';
import zhTW from '../src/i18n/locales/zh-TW';
import th from '../src/i18n/locales/th';

const ticket = {
  title: 'GPU failure', priority: 'HIGH', type: { id: 'incident' }, category: { id: 'gpu' },
  queue: { id: 'default' }, datacenter: null, serialNumber: 'SN-1',
  contact: { phone: '12345', callTime: 'ANY', smsTime: 'NONE', emails: ['ops@example.test'] },
  cluster: { id: 'legacy' }, status: 'IN_PROGRESS', requester: { id: 'requester' }, assignee: { id: 'handler' },
};

describe('ticket attributes patch and permission boundary', () => {
  test('draft clones contact data; an unchanged form never writes', () => {
    const first = attributeDraft(ticket);
    const next = attributeDraft(ticket);
    next.contact.emails.push('other@example.test');
    expect(ticket.contact.emails).toEqual(['ops@example.test']);
    expect(attributePatch(first, attributeDraft(ticket))).toEqual({});
  });
  test('only changed fields are submitted, without status, Cluster, owner or SLA', () => {
    const first = attributeDraft(ticket);
    expect(attributePatch(first, { ...first, datacenterId: 'datazone', serialNumber: ' SN-2 ' }))
      .toEqual({ datacenterId: 'datazone', serialNumber: 'SN-2' });
    expect(first).not.toHaveProperty('clusterId');
  });
  test('optional fields can be explicitly cleared', () => {
    const first = attributeDraft({ ...ticket, datacenter: { id: 'dc-1' } });
    expect(attributePatch(first, { ...first, typeId: '', categoryId: '', queueId: '', datacenterId: '', serialNumber: ' ', contact: null }))
      .toEqual({ typeId: null, categoryId: null, queueId: null, datacenterId: null, serialNumber: null, contact: null });
  });
  test('custom category sentinel is never sent as a database id', () => {
    const first = attributeDraft(ticket);
    expect(attributePatch(first, { ...first, categoryId: CUSTOM_CATEGORY, categoryName: ' Cooling ' }))
      .toEqual({ categoryId: null, categoryName: 'Cooling' });
  });
  test('edit requires write permission and ownership or privileged role; read-all is not write-all', () => {
    const user = (id, roles, permissions = ['ticket:update']) => ({ id, roles, permissions });
    expect(canEditAttributes(user('requester', ['requester']), ticket)).toBe(true);
    expect(canEditAttributes(user('handler', ['handler']), ticket)).toBe(true);
    expect(canEditAttributes(user('admin', ['admin']), ticket)).toBe(true);
    expect(canEditAttributes(user('supervisor', ['supervisor']), ticket)).toBe(true);
    expect(canEditAttributes(user('other', ['handler'], ['ticket:update', 'ticket:read:all']), ticket)).toBe(false);
    expect(canEditAttributes(user('requester', ['observer'], ['ticket:read', 'ticket:read:all']), ticket)).toBe(false);
    expect(canEditAttributes(null, ticket)).toBe(false);
  });
});

test('built-in dropdowns follow all four languages live; custom names and IDs remain data', async () => {
  const i18n = i18next.createInstance();
  const resources = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, th };
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: Object.fromEntries(Object.entries(resources).map(([code, resource]) => [code, { translation: resource }])) });
  for (const [code, resource] of Object.entries(resources)) {
    await i18n.changeLanguage(code);
    expect(metadataLabel(i18n.t, 'type', '故障')).toBe(resource.metadata.incident);
    expect(metadataLabel(i18n.t, 'category', 'IB 网络')).toBe(resource.metadata.ibNetwork);
    expect(metadataLabel(i18n.t, 'category', '以太网网络')).toBe(resource.metadata.ethernet);
    expect(metadataLabel(i18n.t, 'queue', '默认队列')).toBe(resource.metadata.defaultQueue);
    for (const name of ['Cooling / BKK', 'datazone', 'constructor', '__proto__', 'toString']) {
      expect(metadataLabel(i18n.t, 'category', name)).toBe(name);
    }
  }
});
