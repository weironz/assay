import { describe, expect, test } from 'bun:test';
import { isPreviewableSrc, previewImageFromTarget } from '../src/lib/image-preview';

const img = (attrs: Record<string, string>, insideLink = false) => ({
  tagName: 'IMG',
  getAttribute: (name: string) => attrs[name] ?? null,
  closest: (selector: string) => (insideLink && selector === 'a' ? {} : null),
});

describe('#31 工单正文图片预览的事件委托', () => {
  test('从 <img> 取出原图地址与 alt', () => {
    expect(
      previewImageFromTarget(
        img({ src: '/api/tickets/t1/attachments/a1/download', alt: '机架照片' }),
      ),
    ).toEqual({
      src: '/api/tickets/t1/attachments/a1/download',
      alt: '机架照片',
    });
  });

  test('非图片元素、空目标、缺 src 都不触发预览', () => {
    expect(previewImageFromTarget(null)).toBeNull();
    expect(previewImageFromTarget('IMG')).toBeNull();
    expect(
      previewImageFromTarget({ tagName: 'P', getAttribute: () => null }),
    ).toBeNull();
    expect(previewImageFromTarget(img({}))).toBeNull();
    expect(previewImageFromTarget({ tagName: 'IMG' })).toBeNull();
    expect(previewImageFromTarget(img({ src: '   ' }))).toBeNull();
  });

  test('被链接包裹的图片保留原有跳转行为，不抢点击', () => {
    expect(previewImageFromTarget(img({ src: '/a.png' }, true))).toBeNull();
  });

  test('缺 alt 时返回空串，预览层仍可渲染', () => {
    expect(previewImageFromTarget(img({ src: '/a.png' }))).toEqual({
      src: '/a.png',
      alt: '',
    });
  });

  test('只放行正文图片本来就会用的来源', () => {
    for (const src of [
      '/api/x.png',
      './x.png',
      '../x.png',
      '//cdn.example/x.png',
      'x.png',
      'https://cdn.example/x.png',
      'http://localhost:3000/api/x.png',
      'data:image/png;base64,iVBOR',
      'data:image/webp;base64,UklG',
    ]) {
      expect({ src, ok: isPreviewableSrc(src) }).toEqual({ src, ok: true });
    }
  });

  test('危险协议与 SVG data URI 不进入预览层（#3 SVG XSS 防线）', () => {
    for (const src of [
      'javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'file:///etc/passwd',
    ]) {
      expect({ src, ok: isPreviewableSrc(src) }).toEqual({ src, ok: false });
    }
    expect(previewImageFromTarget(img({ src: 'javascript:alert(1)' }))).toBeNull();
  });
});
