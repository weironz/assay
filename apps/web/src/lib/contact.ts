import type { TFunction } from 'i18next';

/**
 * 联系方式的取值表与展示。键必须与后端 apps/api/src/tickets/contact.ts 一致——
 * 库里存的是枚举键，展示文案由这里按当前语言翻译。
 */
export const CONTACT_POSITIONS = [
  'TECH_LEAD',
  'OPS_LEAD',
  'FINANCE',
  'CEO',
  'OTHER',
] as const;

export const CONTACT_TIMES = [
  'ANY',
  'WEEKDAY_9_18',
  'WEEKDAY_9_22',
  'DAILY_9_22',
  'NONE',
] as const;

export const MAX_CONTACT_EMAILS = 5;

export type ContactPosition = (typeof CONTACT_POSITIONS)[number];
export type ContactTime = (typeof CONTACT_TIMES)[number];

export interface TicketContact {
  position?: ContactPosition;
  phone: string;
  callTime: ContactTime;
  smsTime: ContactTime;
  emails: string[];
}

export const EMPTY_CONTACT: TicketContact = {
  phone: '',
  callTime: 'ANY',
  smsTime: 'ANY',
  emails: [],
};

export const positionLabel = (t: TFunction, p: ContactPosition) =>
  t(`contact.position.${p}`);

/**
 * 「不联系」这一项在两个下拉里说的不是一回事——电话是「不要电话联系」，
 * 短信是「不要短信提醒」，所以按字段分开取词，其余时间项共用。
 */
export const timeLabel = (
  t: TFunction,
  v: ContactTime,
  field: 'call' | 'sms',
) => (v === 'NONE' ? t(`contact.${field}None`) : t(`contact.time.${v}`));

/**
 * 一句话概括某个联系时段。NONE 的文案本身已经是完整一句（「不要电话联系」/
 * "Don't call"），再套「电话 …」的壳子就成了「短信 不要短信提醒」这种废话。
 */
export const timePhrase = (
  t: TFunction,
  v: ContactTime,
  field: 'call' | 'sms',
) =>
  v === 'NONE'
    ? t(`contact.${field}None`)
    : t(field === 'call' ? 'contact.summaryCall' : 'contact.summarySms', {
        value: timeLabel(t, v, field),
      });

/** 表单里那行只读摘要，例：手机 13800138000 · 电话 任何时间 · 邮件 x2 */
export function contactSummary(t: TFunction, c: TicketContact): string {
  const parts = [
    t('contact.summaryPhone', { phone: c.phone }),
    timePhrase(t, c.callTime, 'call'),
    timePhrase(t, c.smsTime, 'sms'),
  ];
  if (c.emails.length) {
    parts.push(t('contact.summaryEmails', { n: c.emails.length }));
  }
  return parts.join(' · ');
}
