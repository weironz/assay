import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useCreateTicket,
  useQueues,
  useTypes,
  useCategories,
} from '../features/tickets/api';
import { PRIORITY_LABEL } from '../lib/ticket-meta';
import RichEditor from '../components/RichEditor';

export default function NewTicketPage() {
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
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.body.replace(/<[^>]*>/g, '').trim()) {
      setError('请填写描述');
      return;
    }
    try {
      const payload = {
        ...form,
        typeId: form.typeId || undefined,
        categoryId: form.categoryId || undefined,
        queueId: form.queueId || undefined,
      };
      const t = await createMut.mutateAsync(payload);
      navigate(`/tickets/${t.id}`);
    } catch (err: any) {
      setError(err?.response?.data?.message || '创建失败');
    }
  };

  const inputCls =
    'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';

  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">新建工单</h1>
      <form
        onSubmit={submit}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 space-y-4"
      >
        <div>
          <label className="block text-sm text-gray-500 mb-1">标题 *</label>
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">
            描述 *（支持富文本，可用 Markdown 快捷输入：# 标题、**加粗**、- 列表）
          </label>
          <RichEditor
            placeholder="详细描述问题…"
            minHeight={280}
            onChange={(html) => setForm((f) => ({ ...f, body: html }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-500 mb-1">优先级</label>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className={inputCls}
            >
              {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">类型</label>
            <select
              value={form.typeId}
              onChange={(e) => setForm({ ...form, typeId: e.target.value })}
              className={inputCls}
            >
              <option value="">未指定</option>
              {types?.map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">分类</label>
            <select
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              className={inputCls}
            >
              <option value="">未指定</option>
              {categories?.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-500 mb-1">队列</label>
            <select
              value={form.queueId}
              onChange={(e) => setForm({ ...form, queueId: e.target.value })}
              className={inputCls}
            >
              <option value="">未指定</option>
              {queues?.map((qu: any) => (
                <option key={qu.id} value={qu.id}>
                  {qu.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={createMut.isPending}
            className="rounded-md bg-blue-600 text-white px-5 py-2 text-sm hover:bg-blue-700 disabled:opacity-60"
          >
            {createMut.isPending ? '提交中…' : '提交工单'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/tickets')}
            className="rounded-md border border-gray-300 dark:border-gray-700 px-5 py-2 text-sm"
          >
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
