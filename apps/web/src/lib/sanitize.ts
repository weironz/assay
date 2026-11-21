import DOMPurify from 'dompurify';

if (DOMPurify.isSupported) {
  DOMPurify.addHook('uponSanitizeAttribute', (node, attribute) => {
    if (attribute.attrName === 'class') {
      attribute.keepAttr = node.nodeName === 'CODE'
        && /^language-[a-z][a-z0-9_+#-]{0,31}$/i.test(attribute.attrValue);
    }
  });
}

/** 客户端渲染消毒（服务端已用 sanitize-html 消毒，这里二次防护）。 */
export function renderHtml(dirty: string): { __html: string } {
  return {
    __html: DOMPurify.sanitize(dirty, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote',
        'code', 'pre', 'a', 'img', 'hr',
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'title', 'class'],
    }),
  };
}
