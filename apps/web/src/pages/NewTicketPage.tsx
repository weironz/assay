import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useCreateTicket,
  DEFAULT_TICKET_TYPE_NAME,
  useTypes,
  useCategories,
  useDatacenters,
  uploadDraft,
  attachmentUrl,
  Attachment,
} from '../features/tickets/api';
import { PRIORITY_KEYS, priorityLabel } from '../lib/ticket-meta';
import { metadataLabel } from '../lib/metadata-labels';
import {
  ACCEPT_ATTR,
  EXT_LIST_TEXT,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_MB,
  screenFiles,
} from '../lib/attachments';
import { contactSummary, type TicketContact } from '../lib/contact';
import ContactDialog from '../components/ContactDialog';
import RichEditor from '../components/RichEditor';
import { useAuth } from '../stores/auth';
import { type Msg, useMsg } from '../lib/messages';

/** 分类下拉里「自定义」那一项的哨兵值，不会提交给接口 */
const CUSTOM_CATEGORY = '__custom__';

/** 必填标记。红色星号是通用约定，比在文案里手写 " *" 更醒目也更好统一 */
const Req = () => (
  <span className="text-red-500" aria-hidden>
    *
  </span>
);

export default function NewTicketPage() {
  const { t } = useTranslation();
  const msg = useMsg();
  const navigate = useNavigate();
  const { user } = useAuth();
  const createMut = useCreateTicket();
  const { data: types } = useTypes();
  const { data: categories } = useCategories();
  const { data: datacenters } = useDatacenters();

  const [form, setForm] = useState({
    title: '',
    body: '',
    priority: 'MEDIUM',
    categoryId: '',
    categoryName: '',
    typeId: '',
    datacenterId: '',
    serialNumber: '',
  });
  const defaultTypeId = types?.find(type => type.name === DEFAULT_TICKET_TYPE_NAME)?.id;
  // Derive the preset once options arrive. An explicit user choice wins over refetches.
  const selectedTypeId = form.typeId || defaultTypeId || '';
  const [error, setError] = useState<Msg>(null);
  const request = useRef<{ payload: string; key: string } | null>(null);
  // 正文内联图片与显式附件分开存：数量上限只约束后者，
  // 否则粘 6 张截图就把「最多 5 个附件」占满了
  const [inlineDrafts, setInlineDrafts] = useState<Attachment[]>([]);
  const [drafts, setDrafts] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 联系方式：带出用户上次存的默认值，没存过就是空
  const [contact, setContact] = useState<TicketContact | null>(
    user?.defaultContact ?? null,
  );
  const [saveContactAsDefault, setSaveContactAsDefault] = useState(
    !!user?.defaultContact,
  );
  const [contactOpen, setContactOpen] = useState(false);

  // 编辑器内插图：上传草稿并记录 id
  const uploadImg = async (file: File) => {
    const a = await uploadDraft(file, 'inline');
    setInlineDrafts((d) => [...d, a]);
    return attachmentUrl(a);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const { accepted, rejected } = screenFiles(Array.from(files), drafts.length);
    // 逐条说明为什么被拒，笼统一句「上传失败」等于让用户自己猜
    setFileError(
      rejected.length
        ? rejected
            .map((r) =>
              t(`ticketNew.errFile.${r.code}`, {
                name: r.fileName,
                max: MAX_ATTACHMENTS,
                mb: MAX_ATTACHMENT_MB,
              }),
            )
            .join('\n')
        : null,
    );
    for (const f of accepted) {
      try {
        const a = await uploadDraft(f, 'attachment');
        setDrafts((d) => [...d, a]);
      } catch {
        setFileError(t('ticketNew.errFile.upload', { name: f.name }));
      }
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
        typeId: selectedTypeId || undefined,
        // 自定义分类走 categoryName，服务端负责查重后建；哨兵值不能外泄到接口
        categoryId: custom ? undefined : form.categoryId || undefined,
        categoryName: custom ? form.categoryName.trim() : undefined,
        datacenterId: form.datacenterId || undefined,
        serialNumber: form.serialNumber.trim() || undefined,
        contact: contact ?? undefined,
        saveContactAsDefault: contact ? saveContactAsDefault : undefined,
        attachmentIds: [...inlineDrafts, ...drafts].map((d) => d.id),
      };
      const serialized = JSON.stringify(payload);
      if (request.current?.payload !== serialized) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        request.current = { payload: serialized, key: Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('') };
      }
      const created = await createMut.mutateAsync({ ...payload, idempotencyKey: request.current.key });
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
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 sm:p-6 space-y-4"
      >
        <div>
          <label className="block text-sm text-gray-500 mb-1">
            <Req /> {t('ticketNew.fieldTitle')}
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
            <Req /> {t('ticketNew.fieldBody')}
          </label>
          <RichEditor
            placeholder={t('ticketNew.bodyPlaceholder')}
            minHeight={280}
            onChange={(html) => setForm((f) => ({ ...f, body: html }))}
            onUploadImage={uploadImg}
          />
        </div>

        {/* 附件：按钮 + 右侧规则说明。说明文字由 lib/attachments 的常量拼出，
            改限制时文案自动跟着变，不会出现「写着支持却传不上」 */}
        <div>
          {/* 手机上按钮和说明并排会把说明挤成一条溢出屏幕的长串，改为竖排 */}
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <button
              type="button"
              disabled={drafts.length >= MAX_ATTACHMENTS}
              onClick={() => fileRef.current?.click()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:border-brand-600 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
            >
              <span aria-hidden>⬆</span>
              {t('ticketNew.addFile')}
            </button>
            <p className="w-full min-w-0 break-words text-xs leading-relaxed text-gray-400 sm:flex-1">
              {t('ticketNew.attachmentHint', {
                exts: EXT_LIST_TEXT,
                mb: MAX_ATTACHMENT_MB,
                max: MAX_ATTACHMENTS,
              })}
            </p>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept={ACCEPT_ATTR}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = ''; // 允许再次选同一个文件
              }}
            />
          </div>
          {fileError && (
            <p className="mt-2 whitespace-pre-line text-xs text-red-500">
              {fileError}
            </p>
          )}
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="new-ticket-priority" className="block text-sm text-gray-500 mb-1">
              <Req /> {t('ticketNew.priority')}
            </label>
            <select
              id="new-ticket-priority"
              required
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
            <label htmlFor="new-ticket-type" className="block text-sm text-gray-500 mb-1">
              <Req /> {t('ticketNew.type')}
            </label>
            <select
              id="new-ticket-type"
              required
              value={selectedTypeId}
              onChange={(e) => setForm({ ...form, typeId: e.target.value })}
              className={inputCls}
            >
              {!defaultTypeId && <option value="" disabled>{t('common.pleaseSelect')}</option>}
              {types?.map(item => (
                <option key={item.id} value={item.id}>
                  {metadataLabel(t, 'type', item.name)}
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
                  {metadataLabel(t, 'category', c.name)}
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
          {/* IDC 与设备序列号，均选填；Cluster 已从业务界面移除。 */}
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
          <div className="sm:col-span-2">
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
          <div className="sm:col-span-2">
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
