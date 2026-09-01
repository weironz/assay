import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const lockup = (w: number) => (
    <>
      <img
        src="/brand/greenstor-lockup.png"
        alt="Greenstor"
        width={w}
        className="shrink-0 dark:hidden"
        style={{ width: w, height: 'auto' }}
      />
      <img
        src="/brand/greenstor-lockup-dark.png"
        alt="Greenstor"
        width={w}
        className="hidden shrink-0 dark:block"
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
            {t('brand.subtitle')}
          </span>
          <span className="h-px w-6 bg-gray-300 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  // 副标题长度随语言差一倍："工单系统" 48px、"Ticket System" 84px、
  // 泰语更长。原先 lockup 占 100px，留给副标题的槽正好 83px——英文顶到
  // 边、泰语直接被切。副标题宽度不可控，所以把 lockup 收到 88px 并把侧栏
  // 放宽到 256px，把余量一次性留够（英文余 35px、泰语余 22px）。
  // truncate 只作最后兜底，正常语言不该触发。
  return (
    <Link
      to="/dashboard"
      className="flex min-w-0 items-center gap-2"
      aria-label={t('brand.ariaHome')}
    >
      {lockup(88)}
      <span
        aria-hidden
        className="h-4 w-px shrink-0 bg-gray-300 dark:bg-gray-700"
      />
      <span className="truncate text-[11px] tracking-[0.06em] text-ink-soft dark:text-gray-400">
        {t('brand.subtitle')}
      </span>
    </Link>
  );
}
