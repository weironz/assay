import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

interface Props {
  slaDueAt: string | null;
  status: string;
}

const DONE = ['RESOLVED', 'CLOSED', 'CANCELLED'];

/**
 * Coarse duration: minutes under an hour, hours under a day, then days+hours.
 * Each granularity is its own i18n key so a language can order and space the
 * units its own way ("3 h 20 min" / "3 小時 20 分" / "3 ชม. 20 นาที").
 */
function fmt(t: TFunction, ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return t('sla.durMinutes', { m });
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rest = m % 60;
    return rest
      ? t('sla.durHoursMinutes', { h, m: rest })
      : t('sla.durHours', { h });
  }
  return t('sla.durDaysHours', { d: Math.floor(h / 24), h: h % 24 });
}

/** SLA 倒计时徽章：绿(充裕)/琥珀(临近2h)/红(超时)；已完成或无SLA不显示 */
export default function SlaBadge({ slaDueAt, status }: Props) {
  const { t } = useTranslation();
  if (!slaDueAt || DONE.includes(status)) return null;
  const diff = new Date(slaDueAt).getTime() - Date.now();

  let cls: string;
  let text: string;
  if (diff < 0) {
    cls = 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 font-medium';
    text = t('sla.overdue', { time: fmt(t, -diff) });
  } else if (diff < 2 * 3600_000) {
    cls = 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    text = t('sla.remaining', { time: fmt(t, diff) });
  } else {
    cls = 'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-300';
    text = t('sla.remaining', { time: fmt(t, diff) });
  }
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}
      title={t('sla.title')}
    >
      {text}
    </span>
  );
}
