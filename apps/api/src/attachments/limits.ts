/**
 * 附件规则（服务端）。与 apps/web/src/lib/attachments.ts 保持一致。
 *
 * 前端会先挡一道，但那只是体验；真正的边界在这里——浏览器之外的调用方
 * 一样要受限。
 */
import { PayloadTooLargeException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { getConfig } from '../config';

/**
 * 单个附件上限。
 *
 * 整条链路是流式的：multer 落临时盘 → 以流分片传给对象存储 → 下载直接转发流。
 * 内存占用与文件大小无关（约 32MB/并发），所以这个数受限的是**磁盘**而不是内存：
 * 上传期间临时文件会占盘，N 个并发 ≈ N × 上限。生产 /data 约 24G 可用。
 *
 * 改这里要同步改：
 * - apps/web/src/lib/attachments.ts 的 MAX_ATTACHMENT_MB
 * - apps/web/nginx.conf 的 client_max_body_size（要比本值大出 multipart 头的余量）
 */
export const MAX_ATTACHMENT_MB = 512;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/**
 * 每个工单保留的附件总数上限（含正文内联图片）。
 *
 * 前端 MAX_ATTACHMENTS=5 只约束「附件列表」一次能加几个，接口却可以被直接调用；
 * 这里给单个工单一个总闸门，避免脚本无限追加记录、把数据库和对象存储慢慢撑大。
 * 内联图片也计入，所以留足空间，不按前端的 5 个来卡。
 */
export const MAX_ATTACHMENTS_PER_TICKET = 100;

/** 单个用户 24 小时内的上传次数上限，挡住批量刷接口的脚本。 */
export const MAX_DAILY_UPLOADS = 100;

/** 单个用户 24 小时内的上传总量上限。默认 2GiB，与「单文件 512MB」配套。 */
export const MAX_DAILY_UPLOAD_MB = 2048;
export const MAX_DAILY_UPLOAD_BYTES = MAX_DAILY_UPLOAD_MB * 1024 * 1024;

/**
 * 草稿附件保留时长（小时）。
 *
 * 建单前上传、却一直没关联工单的对象（用户放弃建单、关页面、上传失败重试）
 * 由 AttachmentMaintenanceService 定期回删，不能永久占着对象存储。
 */
export const DRAFT_TTL_HOURS = 24;

/** 上传中转目录。留空则用系统临时目录 */
export const UPLOAD_TMP_DIR = getConfig().files.uploadTmpDir;

/**
 * 上传路由共用的 multer 配置（工单附件 + 业务附件），限额/临时目录只在这一处定义。
 *
 * 落临时盘而不是进内存：默认的 memoryStorage 会把整个文件读进 RAM——
 * 512MB 的附件就是 512MB 常驻内存，两个并发直接把容器打爆。
 * 落盘后由 service 以流的方式转给对象存储，内存占用与文件大小无关。
 * 超限的请求由 limits 在写盘过程中掐断，不会等整个文件传完再拒绝。
 */
export const createAttachmentUploadOptions = () => ({
  storage: diskStorage({ destination: UPLOAD_TMP_DIR || tmpdir() }),
  // +1 是必要的：busboy 在字节数「达到」limit 时就判超限，不是超过才判。
  // 直接填 MAX 会让正好 512MB 的文件被拒，而界面写的是「不得超过 512M」，两边对不上。
  limits: { fileSize: MAX_ATTACHMENT_BYTES + 1 },
});

/**
 * multer 的 limit 是 MAX + 1（busboy 在「达到」时就判超限），真正的大小边界
 * 必须由 service 再校验一次：控制器配置可以被绕过，这个检查不会。
 */
export function assertAttachmentSize(file: Express.Multer.File) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new PayloadTooLargeException(`附件不能超过 ${MAX_ATTACHMENT_MB}MB`);
  }
}

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

/**
 * 位图 MIME → 规范扩展名（jpeg/jpg 统一成 jpg）。
 *
 * 头像和正文内联图只接受位图，落盘文件名需要按 MIME 反查扩展名；这里从
 * RASTER_IMAGE_MIME_BY_EXT 反推，避免头像模块再维护一份同样的表。
 */
const RASTER_IMAGE_EXT_BY_MIME: Record<string, string> = Object.entries(
  RASTER_IMAGE_MIME_BY_EXT,
).reduce<Record<string, string>>((mapping, [ext, mime]) => {
  mapping[mime] ??= ext === 'jpeg' ? 'jpg' : ext;
  return mapping;
}, {});

/** 允许的位图扩展名（png/jpg/gif/webp），供文件名白名单拼接正则 */
export const RASTER_IMAGE_EXTS = Object.values(RASTER_IMAGE_EXT_BY_MIME);

export const extForRasterMime = (mime: string) =>
  RASTER_IMAGE_EXT_BY_MIME[mime] ?? null;

/** 规范扩展名 → 位图 MIME，用于下载响应头 */
export const mimeForRasterExt = (ext: string) =>
  RASTER_IMAGE_MIME_BY_EXT[ext] ?? null;

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
