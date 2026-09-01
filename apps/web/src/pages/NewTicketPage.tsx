import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useCreateTicket,
  useQueues,
  useTypes,
  useCategories,
  useDatacenters,
  useClusters,
  uploadDraft,
  attachmentUrl,
  Attachment,
} from '../features/tickets/api';
import { PRIORITY_KEYS, priorityLabel } from '../lib/ticket-meta';
import { contactSummary, type TicketContact } from '../lib/contact';
import ContactDialog from '../components/ContactDialog';
import RichEditor from '../components/RichEditor';
import { useAuth } from '../stores/auth';
import { type Msg, useMsg } from '../lib/messages';

/** 分类下拉里「自定义」那一项的哨兵值，不会提交给接口 */
const CUSTOM_CATEGORY = '__custom__';

export default function NewTicketPage() {
  const { t } = useTranslation();
  const msg = useMsg();
  const navigate = useNavigate();
  const { user } = useAuth();
  const createMut = useCreateTicket();
  const { data: queues } = useQueues();
  const { data: types } = useTypes();
  const { data: categories } = useCategories();
  const { data: datacenters } = useDatacenters();
  const { data: clusters } = useClusters();

  const [form, setForm] = useState({
    title: '',
    body: '',
    priority: 'MEDIUM',
    categoryId: '',
    categoryName: '',
    typeId: '',
    queueId: '',
    datacenterId: '',
    clusterId: '',
    serialNumber: '',
  });
  const [error, setError] = useState<Msg>(null);
  const [drafts, setDrafts] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // 联系方式：带出用户上次存的默认值，没存过就是空
  const [contact, setContact] = useState<TicketContact | null>(
    user?.defaultContact ?? null,
  );
  const [saveContactAsDefault, setSaveContactAsDefault] = useState(
    !!user?.defaultContact,
  );
  const [contactOpen, setContactOpen] = useState(false);

  // 选了机房就只列该机房下的集群；没选则全列（还没有归属的集群也要能选到）
  const visibleClusters = form.datacenterId
    ? clusters?.filter((c) => c.datacenterId === form.datacenterId)
    : clusters;

  // 编辑器内插图：上传草稿并记录 id
  const uploadImg = async (file: File) => {
    const a = await uploadDraft(file);
    setDrafts((d) => [...d, a]);
    return attachmentUrl(a);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      const a = await uploadDraft(f);
      setDrafts((d) => [...d, a]);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.body.replace(/<[^>]*>/g, '').trim()) {
      setError({ key: 'ticketNew.errBodyRequired' });
      return;
    }
    const custom = form.categoryId === CUSTOM_CATEGORY;
    if (custom && !form.categoryName.trim()) {
      setError({ key: 'ticketNew.errCategoryNameRequired' });
      return;
    }
    try {
      const payload = {
        ...form,
        typeId: form.typeId || undefined,
        // 自定义分类走 categoryName，服务端负责查重后建；哨兵值不能外泄到接口
        categoryId: custom ? undefined : form.categoryId || undefined,
        categoryName: custom ? form.categoryName.trim() : undefined,
        queueId: form.queueId || undefined,
        datacenterId: form.datacenterId || undefined,
        clusterId: form.clusterId || undefined,
        serialNumber: form.serialNumber.trim() || undefined,
        contact: contact ?? undefined,
        saveContactAsDefault: contact ? saveContactAsDefault : undefined,
        attachmentIds: drafts.map((d) => d.id),
      };
      const created = await createMut.mutateAsync(payload);
      navigate(`/tickets/${created.id}`);
    } catch (err: any) {
      const serverMsg = err?.response?.data?.message;
      setError(
        serverMsg ? { raw: serverMsg } : { key: 'ticketNew.errCreateFailed' },
      );
    }
  };

  const inputCls =
    'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">{t('ticketNew.title')}</h1>
      <form
        onSubmit={submit}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 space-y-4"
      >
        <div>
          <label className="block text-sm text-gray-500 mb-1">
            {t('ticketNew.fieldTitle')}
          </label>
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">
            {t('ticketNew.fieldBody')}
          </label>
          <RichEditor
            placeholder={t('ticketNew.bodyPlaceholder')}
            minHeight={280}
            onChange={(html) => setForm((f) => ({ ...f, body: html }))}
            onUploadImage={uploadImg}
          />
        </div>

        {/* 附件 */}
        <div>
          <div className="flex items-center gap-3 mb-1">
            <label className="text-sm text-gray-500">
              {t('ticketNew.attachments')}
            </label>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="text-xs text-brand-700 hover:underline"
            >
              {t('ticketNew.addFile')}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>
          {drafts.length > 0 && (
            <ul className="text-xs space-y-1">
              {drafts.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <span className="text-gray-600 dark:text-gray-300 break-all">
                    {a.mime.startsWith('image/') ? '🖼' : '📎'} {a.fileName}
                  </span>
                  <button
                    type="button"
                    onClick={() => setDrafts((d) => d.filter((x) => x.id !== a.id))}
                    className="text-red-500 hover:underline"
                  >
                    {t('common.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.priority')}
            </label>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className={inputCls}
            >
              {PRIORITY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {priorityLabel(t, k)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.type')}
            </label>
            <select
              value={form.typeId}
              onChange={(e) => setForm({ ...form, typeId: e.target.value })}
              className={inputCls}
            >
              <option value="">{t('common.notSpecified')}</option>
              {types?.map((item: any) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.category')}
            </label>
            <select
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              className={inputCls}
            >
              <option value="">{t('common.notSpecified')}</option>
              {categories?.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={CUSTOM_CATEGORY}>
                {t('ticketNew.categoryCustom')}
              </option>
            </select>
            {form.categoryId === CUSTOM_CATEGORY && (
              <input
                autoFocus
                maxLength={60}
                value={form.categoryName}
                onChange={(e) =>
                  setForm({ ...form, categoryName: e.target.value })
                }
                placeholder={t('ticketNew.categoryCustomPlaceholder')}
                className={`${inputCls} mt-2`}
              />
            )}
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.queue')}
            </label>
            <select
              value={form.queueId}
              onChange={(e) => setForm({ ...form, queueId: e.target.value })}
              className={inputCls}
            >
              <option value="">{t('common.notSpecified')}</option>
              {queues?.map((qu: any) => (
                <option key={qu.id} value={qu.id}>
                  {qu.name}
                </option>
              ))}
            </select>
          </div>
          {/* IDC 资产定位，三项都选填 */}
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.datacenter')}
            </label>
            <select
              value={form.datacenterId}
              onChange={(e) =>
                setForm({
                  ...form,
                  datacenterId: e.target.value,
                  // 换机房后原集群多半不属于新机房了，清掉比留个错值好
                  clusterId: '',
                })
              }
              className={inputCls}
            >
              <option value="">{t('common.notSpecified')}</option>
              {datacenters?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.cluster')}
            </label>
            <select
              value={form.clusterId}
              onChange={(e) => setForm({ ...form, clusterId: e.target.value })}
              className={inputCls}
            >
              <option value="">{t('common.notSpecified')}</option>
              {visibleClusters?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.serialNumber')}
            </label>
            <input
              maxLength={200}
              value={form.serialNumber}
              onChange={(e) =>
                setForm({ ...form, serialNumber: e.target.value })
              }
              placeholder={t('ticketNew.serialNumberPlaceholder')}
              className={inputCls}
            />
          </div>

          {/* 联系方式：只读摘要 + 编辑按钮，具体字段在弹窗里填。整体选填 */}
          <div className="col-span-2">
            <label className="block text-sm text-gray-500 mb-1">
              {t('ticketNew.contact')}
              <span className="ml-1 text-xs text-gray-400">
                {t('common.optional')}
              </span>
            </label>
            <button
              type="button"
              onClick={() => setContactOpen(true)}
              className={`${inputCls} flex items-center justify-between gap-2 text-left hover:border-brand-600`}
            >
              <span
                className={
                  contact
                    ? 'truncate text-gray-800 dark:text-gray-200'
                    : 'truncate text-gray-400'
                }
              >
                {contact
                  ? contactSummary(t, contact)
                  : t('ticketNew.contactPlaceholder')}
              </span>
              <span aria-hidden className="shrink-0 text-gray-400">
                ✎
              </span>
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-red-500">{msg(error)}</p>}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={createMut.isPending}
            className="rounded-md bg-brand-700 text-white px-5 py-2 text-sm hover:bg-brand-800 disabled:opacity-60"
          >
            {createMut.isPending
              ? t('common.submitting')
              : t('ticketNew.submit')}
          </button>
          <button
            type="button"
            onClick={() => navigate('/tickets')}
            className="rounded-md border border-gray-300 dark:border-gray-700 px-5 py-2 text-sm"
          >
            {t('common.cancel')}
          </button>
        </div>
      </form>

      {contactOpen && (
        <ContactDialog
          value={contact}
          defaultSaveAsDefault={saveContactAsDefault}
          onClose={() => setContactOpen(false)}
          onSubmit={(c, asDefault) => {
            setContact(c);
            setSaveContactAsDefault(asDefault);
            setContactOpen(false);
          }}
        />
      )}
    </div>
  );
}
