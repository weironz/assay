import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  clampZoom,
  downloadImage,
  stepIndex,
  type PreviewImage,
} from '../lib/image-preview';

interface Props {
  images: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const BTN =
  'flex h-9 min-w-9 items-center justify-center rounded-full bg-white/15 px-2 text-sm leading-none text-white hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40';

/**
 * 工单正文图片预览层（#31）：多图轮播、缩放/平移、下载原图。
 * 图片地址来自已消毒正文里的 <img>，不经过 innerHTML，也不改附件下载链接。
 */
export default function ImageLightbox({ images, initialIndex = 0, onClose }: Props) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(() => stepIndex(initialIndex, 0, images.length));
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [notice, setNotice] = useState<string | null>(null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(MIN_ZOOM);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // 缩放值同时放 ref：wheel / 双指手势都是原生高频事件，读 ref 才拿得到最新值
  const applyZoom = useCallback((next: number) => {
    const z = clampZoom(next, MIN_ZOOM, MAX_ZOOM);
    zoomRef.current = z;
    setZoom(z);
    if (z === MIN_ZOOM) setOffset({ x: 0, y: 0 });
  }, []);

  const reset = useCallback(() => {
    zoomRef.current = MIN_ZOOM;
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, []);

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => stepIndex(i, delta, images.length));
      reset();
      setNotice(null);
    },
    [images.length, reset],
  );

  // 只跑一次：滚动锁定与焦点恢复，不随缩放状态反复重建
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape': onCloseRef.current(); break;
        case 'ArrowLeft': go(-1); break;
        case 'ArrowRight': go(1); break;
        case '+': case '=': applyZoom(zoomRef.current + ZOOM_STEP); break;
        case '-': applyZoom(zoomRef.current - ZOOM_STEP); break;
        case '0': reset(); break;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [go, reset, applyZoom]);

  // React 的 onWheel 是 passive，preventDefault 不生效，必须原生绑定
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyZoom(zoomRef.current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const image = images[index];
  if (!image) return null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current };
      dragRef.current = null;
    } else if (zoomRef.current > MIN_ZOOM) {
      dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchRef.current.dist > 0) {
        applyZoom(pinchRef.current.zoom * (dist / pinchRef.current.dist));
      }
      return;
    }
    if (dragRef.current && zoomRef.current > MIN_ZOOM) {
      setOffset({
        x: dragRef.current.ox + event.clientX - dragRef.current.x,
        y: dragRef.current.oy + event.clientY - dragRef.current.y,
      });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 0) dragRef.current = null;
  };

  const onDownload = async () => {
    if (await downloadImage(image)) return;
    // fetch 失败（跨域 / 403）时退回浏览器原生打开，不让按钮毫无反应
    const anchor = document.createElement('a');
    anchor.href = image.src;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.click();
    setNotice(t('ticketDetail.imageDownloadFailed'));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('ticketDetail.imagePreview')}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex flex-col bg-black/85 text-white"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
        <span className="min-w-12 text-xs tabular-nums text-white/70">
          {images.length > 1 ? `${index + 1} / ${images.length}` : ''}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {images.length > 1 && (
            <>
              <button type="button" aria-label={t('ticketDetail.imagePrevious')} onClick={() => go(-1)} className={BTN}>‹</button>
              <button type="button" aria-label={t('ticketDetail.imageNext')} onClick={() => go(1)} className={BTN}>›</button>
            </>
          )}
          <button type="button" aria-label={t('ticketDetail.imageZoomOut')} disabled={zoom <= MIN_ZOOM} onClick={() => applyZoom(zoomRef.current - ZOOM_STEP)} className={BTN}>−</button>
          <span className="min-w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label={t('ticketDetail.imageZoomIn')} disabled={zoom >= MAX_ZOOM} onClick={() => applyZoom(zoomRef.current + ZOOM_STEP)} className={BTN}>+</button>
          <button type="button" aria-label={t('ticketDetail.imageZoomReset')} disabled={zoom === MIN_ZOOM && !offset.x && !offset.y} onClick={reset} className={BTN}>1:1</button>
          <button type="button" aria-label={t('ticketDetail.imageDownload')} onClick={onDownload} className={BTN}>↓</button>
          <button ref={closeRef} type="button" aria-label={t('common.close')} onClick={onClose} className={BTN}>×</button>
        </div>
      </div>

      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => applyZoom(zoomRef.current > MIN_ZOOM ? MIN_ZOOM : 2)}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-4 pb-4"
      >
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          className={`max-h-full max-w-full select-none rounded object-contain shadow-2xl ${zoom > MIN_ZOOM ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
        />
        {notice && (
          <p role="status" className="absolute bottom-4 rounded bg-black/70 px-3 py-1.5 text-xs">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
