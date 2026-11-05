import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewImage } from '../lib/image-preview';

interface Props {
  image: PreviewImage;
  onClose: () => void;
}

/**
 * 工单正文图片的原图预览层（#31）。点遮罩空白处、关闭按钮或按 ESC 关闭；
 * 图片本身不响应关闭，避免放大后一点就没了。
 * src 直接来自已消毒正文里的 <img>，不经过 innerHTML，也不改附件下载链接。
 */
export default function ImageLightbox({ image, onClose }: Props) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  // 父级常传内联箭头函数；用 ref 固定回调，避免每次渲染重绑监听，
  // 也避免把「关闭按钮」重新捕获成待恢复的焦点。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('ticketDetail.imagePreview')}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <button
        ref={closeRef}
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-2xl leading-none text-white hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-white"
      >
        ×
      </button>
      <img
        src={image.src}
        alt={image.alt}
        className="max-h-[90vh] max-w-[90vw] rounded object-contain shadow-2xl"
      />
    </div>
  );
}
