import { api } from '../../lib/api';
type Operation = { id: string; state: string; result?: { error?: string } };
export async function awaitOperation(operation: Operation, own = false) {
  let current = operation;
  const started = Date.now();
  while (['pending', 'queued', 'running'].includes(current.state)) {
    if (Date.now() - started > 310_000) throw new Error('操作仍在执行，请查看操作记录；不要重复提交');
    await new Promise(resolve => setTimeout(resolve, 500));
    current = (await api.get(`/samba/${own ? 'me/' : ''}operations/${current.id}`)).data;
  }
  if (current.state !== 'succeeded') throw new Error(current.result?.error || '执行结果需要核对，请查看操作记录');
  return current;
}
