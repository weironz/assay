/** 从富文本正文点击里取出的可预览图片。 */
export interface PreviewImage {
  src: string;
  alt: string;
}

/**
 * 正文经 DOMPurify 消毒后用 dangerouslySetInnerHTML 渲染，内部 <img> 挂不上
 * React 事件，所以由 .rich 容器做事件委托。这里只负责「从事件目标里安全地
 * 取出图片地址」这一件事：用鸭子类型而非 DOM 类型，测试无需浏览器环境。
 */
type ImageTarget = {
  tagName?: string;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
};

/**
 * 只放行正文图片本来就会用的来源：相对路径、http(s)、位图 data URI。
 * 明确排除 svg data URI —— 历史 #3 是 SVG 存储型 XSS，预览层不该给它开口子。
 */
export function isPreviewableSrc(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  if (/^\/|^\.\.?\/|^#/.test(value)) return true;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return true;
  if (scheme === 'http' || scheme === 'https') return true;
  if (scheme === 'data') {
    return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(value);
  }
  return false;
}

export function previewImageFromTarget(target: unknown): PreviewImage | null {
  if (!target || typeof target !== 'object') return null;
  const el = target as ImageTarget;
  if (el.tagName?.toUpperCase() !== 'IMG') return null;
  // 图片被 <a> 包住时保留链接原本的跳转/下载行为，不抢这次点击。
  if (typeof el.closest === 'function' && el.closest('a')) return null;
  const attr = (name: string) =>
    typeof el.getAttribute === 'function' ? (el.getAttribute(name) ?? '') : '';
  const src = attr('src').trim();
  if (!isPreviewableSrc(src)) return null;
  return { src, alt: attr('alt').trim() };
}
