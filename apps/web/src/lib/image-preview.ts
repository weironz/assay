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

/**
 * 事件委托只拿到单个 <img>，轮播却需要整篇正文的图片顺序，故按 DOM 顺序收集。
 * container 仍按鸭子类型处理（只要有 querySelectorAll），测试无需真实 DOM。
 */
export function collectPreviewImages(
  container: ParentNode | null,
  target?: EventTarget | null,
): { images: PreviewImage[]; index: number } {
  if (!container || typeof container.querySelectorAll !== 'function') {
    return { images: [], index: 0 };
  }
  const images: PreviewImage[] = [];
  let index = 0;
  for (const el of container.querySelectorAll('img')) {
    // 复用点击路径的过滤规则，保证「能点的图」和「能轮播的图」是同一批
    const image = previewImageFromTarget(el);
    if (!image) continue;
    if (target != null && el === target) index = images.length;
    images.push(image); // 不去重：同一 src 出现两次就是两张
  }
  return { images, index };
}

/** 循环轮播下标：把 current 与 delta 一起归一化，越界值与负向步进都安全。 */
export function stepIndex(current: number, delta: number, len: number): number {
  const n = Math.trunc(len);
  if (!Number.isFinite(len) || n <= 0) return 0;
  const c = Number.isFinite(current) ? Math.trunc(current) : 0;
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return (((c + d) % n) + n) % n;
}

/** 缩放比例钳到 [min, max] 并保留两位小数；非有限数按有效下界处理，避免污染样式。 */
export function clampZoom(next: number, min = 1, max = 4): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const safe = Number.isFinite(next) ? next : lo;
  return Math.round(Math.min(hi, Math.max(lo, safe)) * 100) / 100;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/** decodeURIComponent 遇到非法 % 序列会抛 URIError，回退原串保住文件名。 */
function decodeSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 剔除路径分隔符与控制字符：download 文件名里出现 / \ 或 .. 会造成路径穿越。 */
function sanitizeFileName(raw: string): string {
  // 先解码再净化，防止 %2F 之类在解码后重新变成路径分隔符
  return decodeSafe(raw)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replaceAll('\\', '')
    .replaceAll('/', '')
    .trim();
}

/** 由 alt 或 src 末段生成安全的下载文件名，缺常见图片扩展名时补 .png。 */
export function downloadFileName(image: PreviewImage): string {
  const alt = image.alt.trim();
  let name = alt ? sanitizeFileName(alt) : '';
  if (!name) {
    const path = image.src.split(/[?#]/)[0];
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    name = sanitizeFileName(path.slice(cut + 1));
  }
  if (!name) name = 'image';
  return IMAGE_EXT_RE.test(name) ? name : `${name}.png`;
}

/**
 * 带凭证拉取原图再触发浏览器下载。任何失败只返回 false，由调用方降级到
 * 「新标签打开」，绝不把异常抛给点击处理函数。
 */
export async function downloadImage(image: PreviewImage): Promise<boolean> {
  let objectUrl: string | null = null;
  let anchor: HTMLAnchorElement | null = null;
  try {
    const res = await fetch(image.src, { credentials: 'include' });
    if (!res.ok) return false;
    objectUrl = URL.createObjectURL(await res.blob());
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = downloadFileName(image);
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    // 立刻 revoke 会让尚未开始的下载失败，故延后释放；用快照避免被下方置空影响
    const url = objectUrl;
    setTimeout(() => {
      if (url) URL.revokeObjectURL(url);
    }, 1000);
    objectUrl = null;
    return true;
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return false;
  } finally {
    anchor?.remove();
  }
}
