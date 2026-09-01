/**
 * 轻量提示条：顶部居中浮层，几秒后自行消失。
 *
 * 用 role="status" + aria-live="polite" 而不是 alert：复制成功属于确认性反馈，
 * 不该打断读屏用户当前的朗读。
 */
export default function Toast({
  show,
  message,
}: {
  show: boolean;
  message: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed left-1/2 top-6 z-50 -translate-x-1/2 transition-all duration-200 ${
        show ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
      }`}
    >
      {show && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
          <span className="text-brand-600" aria-hidden>
            ✓
          </span>
          {message}
        </div>
      )}
    </div>
  );
}
