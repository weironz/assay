/**
 * 附件规则（服务端）。与 apps/web/src/lib/attachments.ts 保持一致。
 *
 * 前端会先挡一道，但那只是体验；真正的边界在这里——浏览器之外的调用方
 * 一样要受限。
 */

/**
 * 单个附件上限。
 *
 * 整条链路是流式的：multer 落临时盘 → 以流分片传给对象存储 → 下载直接转发流。
 * 内存占用与文件大小无关（约 32MB/并发），所以这个数受限的是**磁盘**而不是内存：
 * 上传期间临时文件会占盘，N 个并发 ≈ N × 上限。生产 /data 约 24G 可用。
 *
 * 改这里要同步改：
 * - apps/web/src/lib/attachments.ts 的 MAX_ATTACHMENT_MB
 * - apps/web/nginx.conf 的 client_max_body_size
 */
export const MAX_ATTACHMENT_MB = 512;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/** 上传中转目录。留空则用系统临时目录 */
export const UPLOAD_TMP_DIR = process.env.UPLOAD_TMP_DIR || '';

/**
 * 扩展名 → 服务端认定的 MIME。
 *
 * 客户端提交的 multipart Content-Type 完全可伪造，而它会被写进数据库并在下载时
 * 变成响应头。因此落库的 MIME 只能由这份白名单（图片另外按 magic bytes 核对）
 * 得出，不能直接使用 file.mimetype。
 */
export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  txt: 'text/plain',
  rar: 'application/vnd.rar',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4',
};

/** 显式添加的附件允许的扩展名 */
export const ALLOWED_EXTS = Object.keys(MIME_BY_EXT);

/** 图片扩展名 → 允许的位图 MIME。SVG 是 XML 文档、可执行脚本，必须排除。 */
export const RASTER_IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const RASTER_IMAGE_MIMES = new Set(Object.values(RASTER_IMAGE_MIME_BY_EXT));

export const isRasterImageMime = (mime: string) => RASTER_IMAGE_MIMES.has(mime);

export const extOf = (fileName: string) =>
  fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';

export const mimeForExtension = (fileName: string) =>
  MIME_BY_EXT[extOf(fileName)] ?? 'application/octet-stream';

/**
 * 只按 magic bytes 识别位图，不信任文件名和请求头。
 * 任何不匹配的内容（包括 SVG/HTML）都返回 null。
 */
export function detectRasterImageMime(bytes: Uint8Array): string | null {
  const startsWith = (offset: number, text: string) => {
    if (bytes.length < offset + text.length) return false;
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };

  if (startsWith(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (startsWith(0, 'GIF87a') || startsWith(0, 'GIF89a')) return 'image/gif';
  if (startsWith(0, 'RIFF') && startsWith(8, 'WEBP')) return 'image/webp';
  return null;
}

/**
 * 下载响应使用的类型与是否内联。
 *
 * 只有服务端认可为位图的 MIME 才允许内联；其余（包括历史数据里被伪造成
 * image/svg+xml 的记录）一律作为附件下载。调用方还需补 X-Content-Type-Options:
 * nosniff，避免浏览器绕过头里给的类型去嗅探 HTML。
 */
export function downloadResponse(record: { mime: string; fileName: string }) {
  if (isRasterImageMime(record.mime)) {
    return { mime: record.mime, inline: true };
  }
  return { mime: mimeForExtension(record.fileName), inline: false };
}
