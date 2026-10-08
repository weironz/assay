import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useCategories, useDatacenters, useQueues, useTypes, useUpdateTicket, type TicketDetail } from '../features/tickets/api';
import { attributeDraft, attributePatch, CUSTOM_CATEGORY, type AttributeDraft } from '../lib/ticket-attributes';
import { metadataLabel } from '../lib/metadata-labels';
import { PRIORITY_KEYS, priorityLabel } from '../lib/ticket-meta';
import { CONTACT_POSITIONS, CONTACT_TIMES, EMPTY_CONTACT, MAX_CONTACT_EMAILS, positionLabel, timeLabel, type TicketContact } from '../lib/contact';

const inputClass = 'min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800';
const buttonClass = 'min-h-11 rounded-md border border-gray-300 px-4 py-2 text-sm focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 dark:border-gray-700';

export default function TicketAttributesDialog({ ticket, onClose, onSaved }: {
  ticket: TicketDetail; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const initial = useRef(attributeDraft(ticket));
  const [form, setForm] = useState<AttributeDraft>(initial.current);
  const [emails, setEmails] = useState(initial.current.contact?.emails.join('\n') ?? '');
  const [error, setError] = useState('');
  const update = useUpdateTicket();
  const types = useTypes();
  const categories = useCategories();
  const queues = useQueues();
  const datacenters = useDatacenters();
  const loading = [types, categories, queues, datacenters].some(query => query.isLoading);
  const loadError = [types, categories, queues, datacenters].some(query => query.isError);

  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    return () => { element.close(); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);
  useEffect(() => { if (error) errorElement.current?.focus(); }, [error]);

  const currentForm = () => ({ ...form, contact: form.contact ? {
    ...form.contact, phone: form.contact.phone.trim(), emails: emails.split(/[\n,;]/).map(value => value.trim()).filter(Boolean),
  } : null });
  const close = () => {
    if (update.isPending) return;
    if (Object.keys(attributePatch(initial.current, currentForm())).length && !window.confirm(t('ticketAttributes.discard'))) return;
    onClose();
  };
  const set = (key: keyof AttributeDraft, value: string) => setForm(current => ({ ...current, [key]: value }));
  const setContact = (patch: Partial<TicketContact>) => setForm(current => ({ ...current, contact: { ...EMPTY_CONTACT, ...current.contact, ...patch } }));
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const current = currentForm();
    if (!current.title.trim() || (current.categoryId === CUSTOM_CATEGORY && !current.categoryName.trim()) ||
        (current.contact && (!current.contact.phone || current.contact.emails.length > MAX_CONTACT_EMAILS || current.contact.emails.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))))) {
      setError(t('ticketAttributes.invalidValues')); return;
    }
    const patch = attributePatch(initial.current, current);
    if (!Object.keys(patch).length) { onClose(); return; }
    try { await update.mutateAsync({ id: ticket.id, arg: patch }); onSaved(); }
    catch (err: any) { setError(t(err?.response?.status === 403 ? 'ticketAttributes.forbidden' : err?.response?.status === 400 ? 'ticketAttributes.invalidValues' : 'ticketAttributes.saveFailed')); }
  };

  return <dialog ref={dialog} aria-labelledby="ticket-attributes-title" aria-describedby="ticket-attributes-hint"
    onCancel={event => { event.preventDefault(); close(); }}
    className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-auto rounded-xl border border-gray-200 bg-white p-4 text-gray-800 shadow-xl backdrop:bg-black/40 sm:p-6 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
    <div className="flex items-start justify-between gap-3">
      <div><h2 id="ticket-attributes-title" className="text-lg font-semibold">{t('ticketAttributes.title')}</h2><p id="ticket-attributes-hint" className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('ticketAttributes.hint')}</p></div>
      <button type="button" disabled={update.isPending} onClick={close} aria-label={t('common.close')} className={`${buttonClass} shrink-0`}>×</button>
    </div>
    <form onSubmit={save} className="mt-5 space-y-5">
      {loadError && <div role="alert" className="text-sm text-red-600"><p>{t('ticketAttributes.loadFailed')}</p><button type="button" onClick={() => [types, categories, queues, datacenters].forEach(query => void query.refetch())} className={`${buttonClass} mt-2`}>{t('ticketAttributes.retry')}</button></div>}
      {loading && <p role="status" className="text-sm text-gray-500">{t('common.loading')}</p>}
      <fieldset disabled={loading || loadError || update.isPending} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 disabled:opacity-60">
        <label className="space-y-1 text-sm sm:col-span-2"><span><span className="text-red-500" aria-hidden="true">* </span>{t('ticketNew.fieldTitle')}</span><input autoFocus required value={form.title} onChange={event => set('title', event.target.value)} className={inputClass} /></label>
        <label className="space-y-1 text-sm"><span><span className="text-red-500" aria-hidden="true">* </span>{t('ticketNew.priority')}</span><select required value={form.priority} onChange={event => set('priority', event.target.value)} className={inputClass}>{PRIORITY_KEYS.map(key => <option key={key} value={key}>{priorityLabel(t, key)}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{t('ticketNew.type')}</span><select value={form.typeId} onChange={event => set('typeId', event.target.value)} className={inputClass}><option value="">{t('common.notSpecified')}</option>{types.data?.map(item => <option key={item.id} value={item.id}>{metadataLabel(t, 'type', item.name)}</option>)}</select></label>
        <div><label className="space-y-1 text-sm"><span>{t('ticketNew.category')}</span><select value={form.categoryId} onChange={event => set('categoryId', event.target.value)} className={inputClass}><option value="">{t('common.notSpecified')}</option>{categories.data?.map((item: { id: string; name: string }) => <option key={item.id} value={item.id}>{metadataLabel(t, 'category', item.name)}</option>)}<option value={CUSTOM_CATEGORY}>{t('ticketNew.categoryCustom')}</option></select></label>{form.categoryId === CUSTOM_CATEGORY && <input required maxLength={60} aria-label={t('ticketNew.categoryCustomPlaceholder')} value={form.categoryName} onChange={event => set('categoryName', event.target.value)} placeholder={t('ticketNew.categoryCustomPlaceholder')} className={`${inputClass} mt-2`} />}</div>
        <label className="space-y-1 text-sm"><span>{t('ticketNew.queue')}</span><select value={form.queueId} onChange={event => set('queueId', event.target.value)} className={inputClass}><option value="">{t('common.notSpecified')}</option>{queues.data?.map((item: { id: string; name: string }) => <option key={item.id} value={item.id}>{metadataLabel(t, 'queue', item.name)}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{t('ticketNew.datacenter')}</span><select value={form.datacenterId} onChange={event => set('datacenterId', event.target.value)} className={inputClass}><option value="">{t('common.notSpecified')}</option>{datacenters.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{t('ticketNew.serialNumber')}</span><input maxLength={200} value={form.serialNumber} onChange={event => set('serialNumber', event.target.value)} placeholder={t('ticketNew.serialNumberPlaceholder')} className={inputClass} /></label>
        <fieldset className="min-w-0 space-y-3 border-t border-gray-200 pt-4 sm:col-span-2 dark:border-gray-700">
          <legend className="text-sm font-medium">{t('ticketNew.contact')}</legend>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={!!form.contact} onChange={event => setForm(current => ({ ...current, contact: event.target.checked ? { ...EMPTY_CONTACT, emails: [] } : null }))} />{t('ticketAttributes.contactEnabled')}</label>
          {form.contact && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm"><span><span aria-hidden="true" className="text-red-500">* </span>{t('contact.phone')}</span><input type="tel" required maxLength={40} value={form.contact.phone} onChange={event => setContact({ phone: event.target.value })} className={inputClass} /></label>
            <label className="space-y-1 text-sm"><span>{t('contact.position.label')}</span><select value={form.contact.position ?? ''} onChange={event => setContact({ position: (event.target.value || undefined) as TicketContact['position'] })} className={inputClass}><option value="">{t('common.notSpecified')}</option>{CONTACT_POSITIONS.map(key => <option key={key} value={key}>{positionLabel(t, key)}</option>)}</select></label>
            {(['callTime', 'smsTime'] as const).map(field => <label key={field} className="space-y-1 text-sm"><span>{t(`contact.${field}`)}</span><select value={form.contact![field]} onChange={event => setContact({ [field]: event.target.value })} className={inputClass}>{CONTACT_TIMES.map(key => <option key={key} value={key}>{timeLabel(t, key, field === 'callTime' ? 'call' : 'sms')}</option>)}</select></label>)}
            <label className="space-y-1 text-sm sm:col-span-2"><span>{t('contact.emailAlerts')}</span><textarea value={emails} onChange={event => setEmails(event.target.value)} aria-describedby="ticket-contact-emails-hint" rows={3} className={inputClass} /><span id="ticket-contact-emails-hint" className="block text-xs text-gray-500 dark:text-gray-400">{t('ticketAttributes.emailsHint', { max: MAX_CONTACT_EMAILS })}</span></label>
          </div>}
        </fieldset>
      </fieldset>
      {error && <p ref={errorElement} tabIndex={-1} role="alert" className="text-sm text-red-600 focus:outline-none">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-700"><button type="button" disabled={update.isPending} onClick={close} className={buttonClass}>{t('common.cancel')}</button><button type="submit" disabled={loading || loadError || update.isPending} className={`${buttonClass} border-transparent bg-brand-700 text-white hover:bg-brand-800`}>{update.isPending ? t('common.submitting') : t('common.save')}</button></div>
    </form>
  </dialog>;
}
