/**
 * 附件规则。界面上那行说明文字由这里的常量拼出来，校验也用同一份常量——
 * 说明和实际限制只能一起改，不会出现「写着支持 mp4 结果传不上去」。
 *
 * 服务端有一份对应的 apps/api/src/attachments/limits.ts，两边必须一致。
 */
export const MAX_ATTACHMENTS = 5;

/**
 * 单个附件上限。目前整条上传链路是「整包进内存」——multer 缓冲到内存、
 * 再整块交给 S3 驱动，下载同理。所以这个数不能随便调大：调到 GB 级会直接
 * 把 API 容器打爆。真要支持超大文件得先改成流式上传（见 README）。
 * 改这里的同时必须改 apps/web/nginx.conf 的 client_max_body_size。
 */
export const MAX_ATTACHMENT_MB = 100;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/** 允许的扩展名，小写不带点 */
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
] as const;

/** <input accept> 用的值 */
export const ACCEPT_ATTR = ALLOWED_EXTS.map((e) => `.${e}`).join(',');

/** 说明文字里展示的格式列表 */
export const EXT_LIST_TEXT = ALLOWED_EXTS.map((e) => `.${e}`).join('、');

export const extOf = (fileName: string) =>
  fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';

export type FileReject = { code: 'ext' | 'size' | 'count'; fileName: string };

/**
 * 校验一批待加入的文件。返回可接受的文件与被拒原因，调用方决定怎么提示。
 * 数量按「已有 + 本次」算，避免分多次选文件绕过上限。
 */
export function screenFiles(
  files: File[],
  existingCount: number,
): { accepted: File[]; rejected: FileReject[] } {
  const accepted: File[] = [];
  const rejected: FileReject[] = [];
  for (const f of files) {
    if (!(ALLOWED_EXTS as readonly string[]).includes(extOf(f.name))) {
      rejected.push({ code: 'ext', fileName: f.name });
    } else if (f.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ code: 'size', fileName: f.name });
    } else if (existingCount + accepted.length >= MAX_ATTACHMENTS) {
      rejected.push({ code: 'count', fileName: f.name });
    } else {
      accepted.push(f);
    }
  }
  return { accepted, rejected };
}
