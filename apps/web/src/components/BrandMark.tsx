import { Link } from 'react-router-dom';

/**
 * Greenstor 品牌锁定组合：官方 logo │ 工单系统
 *
 * 用官方 lockup 原图，不重绘、不拆分字标——字标那套几何无衬线我们没有，
 * 自己排只会失真。深色模式换用同一张图的浅色字标版（保留品牌绿图标）。
 */
export default function BrandMark({
  variant = 'bar',
}: {
  /** bar：侧边栏横排；stack：登录页竖排放大 */
  variant?: 'bar' | 'stack';
}) {
  const lockup = (w: number) => (
    <>
      <img
        src="/brand/greenstor-lockup.png"
        alt="Greenstor"
        width={w}
        className="dark:hidden"
        style={{ width: w, height: 'auto' }}
      />
      <img
        src="/brand/greenstor-lockup-dark.png"
        alt="Greenstor"
        width={w}
        className="hidden dark:block"
        style={{ width: w, height: 'auto' }}
      />
    </>
  );

  if (variant === 'stack') {
    return (
      <div className="flex flex-col items-center gap-3">
        {lockup(196)}
        <div className="flex items-center gap-3">
          <span className="h-px w-6 bg-gray-300 dark:bg-gray-700" />
          <span className="text-sm tracking-[0.32em] text-ink-soft dark:text-gray-400">
            工单系统
          </span>
          <span className="h-px w-6 bg-gray-300 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  return (
    <Link
      to="/dashboard"
      className="flex items-center gap-2.5"
      aria-label="Greenstor 工单系统"
    >
      {lockup(116)}
      <span
        aria-hidden
        className="h-4 w-px shrink-0 bg-gray-300 dark:bg-gray-700"
      />
      <span className="whitespace-nowrap text-[13px] tracking-[0.14em] text-ink-soft dark:text-gray-400">
        工单系统
      </span>
    </Link>
  );
}
