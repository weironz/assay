import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  useCreateTicket,
  useQueues,
  useTypes,
  useCategories,
  uploadDraft,
  attachmentUrl,
  Attachment,
} from '../features/tickets/api';
import { PRIORITY_KEYS, priorityLabel } from '../lib/ticket-meta';
import RichEditor from '../components/RichEditor';
import { type Msg, useMsg } from '../lib/messages';

export default function NewTicketPage() {
  const { t } = useTranslation();
  const msg = useMsg();
  const navigate = useNavigate();
  const createMut = useCreateTicket();
  const { data: queues } = useQueues();
  const { data: types } = useTypes();
  const { data: categories } = useCategories();

  const [form, setForm] = useState({
    title: '',
    body: '',
    priority: 'MEDIUM',
    typeId: '',
    categoryId: '',
    queueId: '',
  });
  const [error, setError] = useState<Msg>(null);
  const [drafts, setDrafts] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

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
    try {
      const payload = {
        ...form,
        typeId: form.typeId || undefined,
        categoryId: form.categoryId || undefined,
        queueId: form.queueId || undefined,
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
            </select>
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
    </div>
  );
}
