import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CONTACT_POSITIONS,
  CONTACT_TIMES,
  EMPTY_CONTACT,
  MAX_CONTACT_EMAILS,
  positionLabel,
  timeLabel,
  type ContactTime,
  type TicketContact,
} from '../lib/contact';

/**
 * 联系方式编辑弹窗。表单里那格是只读摘要，真正的录入都在这里。
 *
 * 手机号是这里唯一的必填项：一份联系方式没有号码就没有意义。但整个联系方式
 * 本身是选填的——不打开这个弹窗就不填，工单照样能提交。
 */
export default function ContactDialog({
  value,
  defaultSaveAsDefault,
  onClose,
  onSubmit,
}: {
  value: TicketContact | null;
  /** 上次是否勾了「设为默认」，决定复选框初始态 */
  defaultSaveAsDefault?: boolean;
  onClose: () => void;
  onSubmit: (contact: TicketContact | null, saveAsDefault: boolean) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<TicketContact>(value ?? EMPTY_CONTACT);
  const [emails, setEmails] = useState<string[]>(value?.emails ?? []);
  const [asDefault, setAsDefault] = useState(!!defaultSaveAsDefault);
  const [touched, setTouched] = useState(false);

  // Esc 关闭：弹窗盖住整个表单，键盘用户得有退路
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const phoneMissing = !form.phone.trim();

  const confirm = () => {
    if (phoneMissing) {
      setTouched(true);
      return;
    }
    onSubmit(
      { ...form, phone: form.phone.trim(), emails: emails.map((e) => e.trim()).filter(Boolean) },
      asDefault,
    );
  };

  const fieldCls =
    'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';
  const labelCls = 'text-sm text-gray-500 pt-2';

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('contact.dialogTitle')}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-full max-w-lg overflow-auto rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('contact.dialogTitle')}</h2>
          <button
            onClick={onClose}
            aria-label={t('common.cancel')}
            className="text-xl leading-none text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-[6rem_1fr] items-start gap-x-4 gap-y-3">
          <label className={labelCls} htmlFor="contact-position">
            {t('contact.position.label')}
          </label>
          <select
            id="contact-position"
            className={fieldCls}
            value={form.position ?? ''}
            onChange={(e) =>
              setForm({
                ...form,
                position: (e.target.value || undefined) as TicketContact['position'],
              })
            }
          >
            <option value="">{t('common.notSpecified')}</option>
            {CONTACT_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {positionLabel(t, p)}
              </option>
            ))}
          </select>

          <label className={labelCls} htmlFor="contact-phone">
            <span className="text-red-500">*</span> {t('contact.phone')}
          </label>
          <div>
            <input
              id="contact-phone"
              autoFocus
              maxLength={40}
              className={fieldCls}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder={t('contact.phonePlaceholder')}
            />
            {touched && phoneMissing && (
              <p className="mt-1 text-xs text-red-500">
                {t('contact.errPhoneRequired')}
              </p>
            )}
          </div>

          <label className={labelCls} htmlFor="contact-call">
            <span className="text-red-500">*</span> {t('contact.callTime')}
          </label>
          <select
            id="contact-call"
            className={fieldCls}
            value={form.callTime}
            onChange={(e) =>
              setForm({ ...form, callTime: e.target.value as ContactTime })
            }
          >
            {CONTACT_TIMES.map((v) => (
              <option key={v} value={v}>
                {timeLabel(t, v, 'call')}
              </option>
            ))}
          </select>

          <label className={labelCls} htmlFor="contact-sms">
            <span className="text-red-500">*</span> {t('contact.smsTime')}
          </label>
          <select
            id="contact-sms"
            className={fieldCls}
            value={form.smsTime}
            onChange={(e) =>
              setForm({ ...form, smsTime: e.target.value as ContactTime })
            }
          >
            {CONTACT_TIMES.map((v) => (
              <option key={v} value={v}>
                {timeLabel(t, v, 'sms')}
              </option>
            ))}
          </select>

          <span className={labelCls}>{t('contact.emailAlerts')}</span>
          <div className="space-y-2">
            {emails.map((addr, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="email"
                  className={fieldCls}
                  value={addr}
                  placeholder={t('contact.emailPlaceholder')}
                  onChange={(e) =>
                    setEmails(emails.map((v, j) => (j === i ? e.target.value : v)))
                  }
                />
                <button
                  type="button"
                  onClick={() => setEmails(emails.filter((_, j) => j !== i))}
                  className="shrink-0 text-sm text-brand-700 hover:underline"
                >
                  {t('common.remove')}
                </button>
              </div>
            ))}
            {emails.length < MAX_CONTACT_EMAILS && (
              <button
                type="button"
                onClick={() => setEmails([...emails, ''])}
                className="text-sm text-brand-700 hover:underline"
              >
                {t('contact.addEmail')}
              </button>
            )}
          </div>
        </div>

        <label className="mt-5 flex items-center gap-2 border-t border-gray-200 pt-4 text-sm dark:border-gray-800">
          <input
            type="checkbox"
            checked={asDefault}
            onChange={(e) => setAsDefault(e.target.checked)}
          />
          {t('contact.saveAsDefault')}
        </label>

        <div className="mt-5 flex justify-end gap-2">
          {/* 已经填过才给清除入口——没填过的话这个按钮没有意义 */}
          {value && (
            <button
              type="button"
              onClick={() => onSubmit(null, false)}
              className="mr-auto rounded-md px-3 py-2 text-sm text-red-600 hover:underline"
            >
              {t('contact.clear')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
          >
            {t('common.close')}
          </button>
          <button
            type="button"
            onClick={confirm}
            className="rounded-md bg-brand-700 px-4 py-2 text-sm text-white hover:bg-brand-800"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
