import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Queue {
  id: string;
  name: string;
  description: string | null;
}

export default function QueuesPage() {
  const qc = useQueryClient();
  const { data: queues } = useQuery<Queue[]>({
    queryKey: ['queues'],
    queryFn: async () => (await api.get('/queues')).data,
  });
  const [form, setForm] = useState({ name: '', description: '' });

  const createMut = useMutation({
    mutationFn: async () => (await api.post('/queues', form)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queues'] });
      setForm({ name: '', description: '' });
    },
  });
  const delMut = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/queues/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    createMut.mutate();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">队列管理</h1>

      <form
        onSubmit={submit}
        className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 flex gap-3 items-end"
      >
        <input
          placeholder="队列名称"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <input
          placeholder="描述（可选）"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={createMut.isPending}
          className="rounded-md bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-60"
        >
          新建队列
        </button>
      </form>

      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">名称</th>
              <th className="text-left px-4 py-2">描述</th>
              <th className="text-right px-4 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {queues?.map((q) => (
              <tr
                key={q.id}
                className="border-t border-gray-100 dark:border-gray-800"
              >
                <td className="px-4 py-2">{q.name}</td>
                <td className="px-4 py-2 text-gray-500">{q.description}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => delMut.mutate(q.id)}
                    className="text-red-500 hover:underline"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
