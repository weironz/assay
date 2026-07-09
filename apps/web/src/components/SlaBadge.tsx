interface Props {
  slaDueAt: string | null;
  status: string;
}

const DONE = ['RESOLVED', 'CLOSED', 'CANCELLED'];

function fmt(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时${m % 60 ? (m % 60) + '分' : ''}`;
  return `${Math.floor(h / 24)}天${h % 24}小时`;
}

/** SLA 倒计时徽章：绿(充裕)/琥珀(临近2h)/红(超时)；已完成或无SLA不显示 */
export default function SlaBadge({ slaDueAt, status }: Props) {
  if (!slaDueAt || DONE.includes(status)) return null;
  const diff = new Date(slaDueAt).getTime() - Date.now();

  let cls: string;
  let text: string;
  if (diff < 0) {
    cls = 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300';
    text = `超时 ${fmt(-diff)}`;
  } else if (diff < 2 * 3600_000) {
    cls = 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300';
    text = `剩 ${fmt(diff)}`;
  } else {
    cls = 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
    text = `剩 ${fmt(diff)}`;
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`} title="SLA 剩余时间">
      {text}
    </span>
  );
}
