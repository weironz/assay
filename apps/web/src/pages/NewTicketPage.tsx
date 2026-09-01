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
  const { data: queues } = useQueues();
  const { data: types } = useTypes();
  const { data: categories } = useCategories();
  const { data: datacenters } = useDatacenters();
  const { data: clusters } = useClusters();

  const [form, setForm] = useState({
    title: '',
    body: '',
    priority: '',
    categoryId: '',
    categoryName: '',
    typeId: '',
    queueId: '',
    datacenterId: '',
    clusterId: '',
    serialNumber: '',
  });
  const [error, setError] = useState<Msg>(null);
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

  // 选了机房就只列该机房下的集群；没选则全列（还没有归属的集群也要能选到）
  const visibleClusters = form.datacenterId
    ? clusters?.filter((c) => c.datacenterId === form.datacenterId)
    : clusters;

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
        attachmentIds: [...inlineDrafts, ...drafts].map((d) => d.id),
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
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={drafts.length >= MAX_ATTACHMENTS}
              onClick={() => fileRef.current?.click()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:border-brand-600 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200"
            >
              <span aria-hidden>⬆</span>
              {t('ticketNew.addFile')}
            </button>
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-gray-400">
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
        <div className="grid grid-cols-2 gap-4">
          {/* 优先级与类型必选：不给默认值，逼用户自己判断。
              留个默认「中」等于大家都不填，SLA 就失去意义了 */}
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              <Req /> {t('ticketNew.priority')}
            </label>
            <select
              required
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className={inputCls}
            >
              <option value="">{t('common.pleaseSelect')}</option>
              {PRIORITY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {priorityLabel(t, k)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">
              <Req /> {t('ticketNew.type')}
            </label>
            <select
              required
              value={form.typeId}
              onChange={(e) => setForm({ ...form, typeId: e.target.value })}
              className={inputCls}
            >
              <option value="">{t('common.pleaseSelect')}</option>
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
