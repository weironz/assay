export const STATUS_LABEL: Record<string, string> = {
  NEW: '待处理',
  ASSIGNED: '已指派',
  IN_PROGRESS: '处理中',
  PENDING: '挂起',
  RESOLVED: '待验收',
  CLOSED: '已关闭',
  REOPENED: '重新打开',
  CANCELLED: '已取消',
};

export const STATUS_COLOR: Record<string, string> = {
  NEW: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  ASSIGNED: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  IN_PROGRESS: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  PENDING: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  RESOLVED: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  CLOSED: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  REOPENED: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
};

export const PRIORITY_LABEL: Record<string, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  URGENT: '紧急',
};

export const PRIORITY_COLOR: Record<string, string> = {
  LOW: 'text-gray-500',
  MEDIUM: 'text-blue-600',
  HIGH: 'text-orange-600',
  URGENT: 'text-red-600 font-semibold',
};

export const ACTION_LABEL: Record<string, string> = {
  start: '开始处理',
  hold: '挂起',
  resume: '恢复处理',
  resolve: '提交处理结果',
  close: '验收关闭',
  reopen: '重新打开',
  cancel: '取消工单',
};
