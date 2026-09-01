import type { TFunction } from 'i18next';

/** Workflow states, in the order they should appear in filters/charts */
export const STATUS_KEYS = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
  'CANCELLED',
] as const;

/**
 * Labels come from i18n rather than a frozen Record, so every caller has to
 * pass the active `t`. Unknown values (a status the API adds later) fall back
 * to the raw enum instead of rendering an empty cell.
 */
export const statusLabel = (t: TFunction, status: string) =>
  t(`status.${status}`, { defaultValue: status });

/**
 * 状态配色遵循一条规则：颜色标记「需要有人动手的事」，不标记「已经结束的事」。
 *
 * 品牌绿已经是操作色（按钮、导航选中），所以状态里只有「处理中」用极淡的品牌绿底，
 * 它读作"系统正在推进"，与实心绿按钮在明度上拉开，不会被误认成可点击。
 * 终态（已关闭 / 已取消）刻意压成灰色——一屏工单里它们不该抢注意力。
 * 只有三个状态带暖色：挂起（卡住）、待验收（等提单人确认）、重新打开（返工）。
 */
export const STATUS_COLOR: Record<string, string> = {
  // 排队中 / 已有人负责：中性，不喧哗
  NEW: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  ASSIGNED: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  // 正在推进：淡品牌绿
  IN_PROGRESS: 'bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-300',
  // 需要有人动手
  PENDING: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  RESOLVED: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  REOPENED: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  // 终态：安静
  CLOSED: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  CANCELLED: 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500',
};

export const PRIORITY_KEYS = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export const priorityLabel = (t: TFunction, priority: string) =>
  t(`priority.${priority}`, { defaultValue: priority });

/** 优先级同理：只有高/紧急值得用颜色喊人，低/中保持中性 */
export const PRIORITY_COLOR: Record<string, string> = {
  LOW: 'text-gray-400',
  MEDIUM: 'text-gray-600 dark:text-gray-300',
  HIGH: 'text-amber-600 font-medium',
  URGENT: 'text-red-600 font-semibold',
};

/**
 * SLA 导轨颜色：编码「时间压力」，与状态标签（工作流阶段）分属两个信息通道。
 * 借用机架指示灯的语言——扫一眼整列就知道哪几条在烧时间。
 */
export function slaRailColor(
  slaDueAt: string | null,
  status: string,
): string | undefined {
  const DONE = ['RESOLVED', 'CLOSED', 'CANCELLED'];
  if (!slaDueAt || DONE.includes(status)) return undefined;
  const diff = new Date(slaDueAt).getTime() - Date.now();
  if (diff < 0) return 'var(--color-red-500)'; // 已超时
  if (diff < 2 * 3600_000) return 'var(--color-amber-400)'; // 2 小时内到期
  return 'var(--color-brand-400)'; // 时间充裕
}

/** Workflow transition buttons offered by the API (`availableActions`) */
export const actionLabel = (t: TFunction, action: string) =>
  t(`ticketAction.${action}`, { defaultValue: action });

/** Audit-history verbs */
export const historyActionLabel = (t: TFunction, action: string) =>
  t(`historyAction.${action}`, { defaultValue: action });
