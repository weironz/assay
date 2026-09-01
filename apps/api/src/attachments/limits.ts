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

/** 显式添加的附件允许的扩展名 */
export const ALLOWED_EXTS = [
  'png',
  'jpeg',
  'jpg',
  'txt',
  'rar',
  'zip',
  'doc',
  'docx',
  'xls',
  'xlsx',
  '7z',
  'mp4',
];

/**
 * 正文内联图片走的是另一套：用户截图粘贴进来可能是 webp/gif，
 * 按附件白名单挡会直接把粘贴功能废掉，所以只要求是图片。
 */
export const isInlineImage = (mime: string) => mime.startsWith('image/');

export const extOf = (fileName: string) =>
  fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
