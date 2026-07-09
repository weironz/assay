import sanitizeHtml from 'sanitize-html';

/**
 * 服务端 HTML 白名单消毒（入库前调用）。
 * 白名单覆盖 Tiptap 可能输出的标签；img 仅允许站内附件下载地址与 data 图。
 * 前端渲染时还会再经 DOMPurify 二次消毒（双端防 XSS）。
 */
export function cleanHtml(dirty: string): string {
  return sanitizeHtml(dirty, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
      'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote',
      'code', 'pre', 'a', 'img', 'hr',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    transformTags: {
      // 外链统一加安全属性
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer',
        target: '_blank',
      }),
    },
  });
}
