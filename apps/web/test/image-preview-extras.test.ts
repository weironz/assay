import { describe, expect, test } from 'bun:test';
import {
  clampZoom,
  collectPreviewImages,
  downloadFileName,
  stepIndex,
} from '../src/lib/image-preview';

const mkImg = (src: string, alt = '', inLink = false) => ({
  tagName: 'IMG',
  src,
  alt,
  getAttribute: (name: string) =>
    name === 'src' ? src : name === 'alt' ? alt : null,
  closest: (selector: string) => (inLink && selector === 'a' ? {} : null),
});

const mkOther = (tagName: string) => ({
  tagName,
  getAttribute: () => null,
  closest: () => null,
});

const container = (imgs: unknown[]) =>
  ({ querySelectorAll: (_selector: string) => imgs }) as unknown as ParentNode;

const asTarget = (el: unknown) => el as unknown as EventTarget;

describe('collectPreviewImages 从正文容器收集可预览图片', () => {
  test('按 DOM 顺序收集可预览图片，顺序与 querySelectorAll 一致', () => {
    const box = container([
      mkImg('/a.png', '甲'),
      mkImg('/b.png'),
      mkImg('/c.png', '丙'),
    ]);
    expect(collectPreviewImages(box).images).toEqual([
      { src: '/a.png', alt: '甲' },
      { src: '/b.png', alt: '' },
      { src: '/c.png', alt: '丙' },
    ]);
  });

  test('重复 src 不去重，两张同址图片都进入列表', () => {
    const box = container([
      mkImg('/same.png', '一'),
      mkImg('/same.png', '二'),
    ]);
    expect(collectPreviewImages(box).images).toEqual([
      { src: '/same.png', alt: '一' },
      { src: '/same.png', alt: '二' },
    ]);
  });

  test('过滤 <a> 内图片、无 src 与空白 src、非 IMG 元素', () => {
    const box = container([
      mkImg('/linked.png', '链接内', true),
      mkImg('', '空 src'),
      mkImg('   ', '空白 src'),
      mkOther('DIV'),
      mkImg('/a.png', 'A'),
      mkOther('SPAN'),
      mkImg('/b.png', 'B'),
    ]);
    expect(collectPreviewImages(box).images).toEqual([
      { src: '/a.png', alt: 'A' },
      { src: '/b.png', alt: 'B' },
    ]);
  });

  test('javascript: 与 data:image/svg+xml 不进入预览列表（呼应 #3 SVG XSS 防线）', () => {
    const box = container([
      mkImg('javascript:alert(1)'),
      mkImg('data:image/svg+xml,<svg onload=alert(1)>'),
      mkImg('data:image/svg+xml;base64,PHN2Zz4='),
      mkImg('/safe.png', '安全'),
    ]);
    expect(collectPreviewImages(box).images).toEqual([
      { src: '/safe.png', alt: '安全' },
    ]);
  });

  test('target 命中第 N 张时 index 为过滤后的下标，未命中回落首张', () => {
    const linked = mkImg('/linked.png', '', true);
    const a = mkImg('/a.png');
    const b = mkImg('/b.png');
    const c = mkImg('/c.png');
    const box = container([
      mkImg(''),
      linked,
      a,
      mkOther('P'),
      b,
      mkImg('javascript:alert(1)'),
      c,
    ]);
    expect(collectPreviewImages(box, asTarget(a)).index).toBe(0);
    expect(collectPreviewImages(box, asTarget(b)).index).toBe(1);
    expect(collectPreviewImages(box, asTarget(c)).index).toBe(2);
    expect(collectPreviewImages(box, asTarget(linked)).index).toBe(0);
    expect(collectPreviewImages(box).index).toBe(0);
    expect(collectPreviewImages(box, null).index).toBe(0);
  });

  test('container 为 null 时返回空列表与默认 index', () => {
    expect(collectPreviewImages(null)).toEqual({ images: [], index: 0 });
    expect(collectPreviewImages(null, asTarget(mkImg('/x.png')))).toEqual({
      images: [],
      index: 0,
    });
  });
});

describe('stepIndex 预览翻页下标', () => {
  test('正向步进循环，末尾回到首张', () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
  });

  test('负向步进循环，首张回到末张', () => {
    expect(stepIndex(2, -1, 3)).toBe(1);
    expect(stepIndex(1, -1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  test('delta 超过 ±len 时仍按模循环', () => {
    expect(stepIndex(0, 7, 3)).toBe(1);
    expect(stepIndex(0, -7, 3)).toBe(2);
    expect(stepIndex(0, 3, 3)).toBe(0);
    expect(stepIndex(0, -3, 3)).toBe(0);
  });

  test('len <= 0 时返回 0，不产生 NaN', () => {
    for (const len of [0, -1, -3]) {
      const result = stepIndex(0, 1, len);
      expect(result).toBe(0);
      expect(Number.isFinite(result)).toBe(true);
    }
    expect(stepIndex(2, -1, 0)).toBe(0);
    expect(stepIndex(5, 3, -1)).toBe(0);
  });

  test('current 越界（负数或超过 len）先归一化再步进', () => {
    expect(stepIndex(10, 0, 3)).toBe(1);
    expect(stepIndex(-1, 0, 3)).toBe(2);
    expect(stepIndex(9, 1, 3)).toBe(1);
    expect(stepIndex(-2, 1, 3)).toBe(2);
  });
});

describe('clampZoom 缩放值裁剪', () => {
  test('自定义 min/max 裁剪上下界，范围内的值原样保留', () => {
    expect(clampZoom(0.1, 0.5, 4)).toBe(0.5);
    expect(clampZoom(99, 0.5, 4)).toBe(4);
    expect(clampZoom(2, 0.5, 4)).toBe(2);
  });

  test('换一组自定义 min/max 同样生效', () => {
    expect(clampZoom(0.123, 0.25, 2)).toBe(0.25);
    expect(clampZoom(3.456, 0.25, 2)).toBe(2);
    expect(clampZoom(1.5, 0.25, 2)).toBe(1.5);
  });

  test('结果保留两位小数', () => {
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(1.236, 0.5, 4)).toBe(1.24);
    expect(clampZoom(2.5, 0.5, 4)).toBe(2.5);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  test('NaN 与 ±Infinity 回落到有效下界，自定义下界时随之变化', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
    expect(clampZoom(-Infinity)).toBe(1);
    expect(clampZoom(NaN, 0.5, 4)).toBe(0.5);
    expect(clampZoom(Infinity, 0.5, 4)).toBe(0.5);
    expect(clampZoom(-Infinity, 2, 5)).toBe(2);
    expect(clampZoom(NaN, 4, 1)).toBe(1);
  });

  test('默认边界把极端值裁进有限区间且不反转大小关系', () => {
    const hi = clampZoom(1e9);
    const lo = clampZoom(-1e9);
    expect(Number.isFinite(hi)).toBe(true);
    expect(Number.isFinite(lo)).toBe(true);
    expect(hi).toBeLessThanOrEqual(10);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('downloadFileName 生成下载文件名', () => {
  test('alt 优先于 src 的 URL 末段', () => {
    expect(
      downloadFileName({ src: '/api/files/real.png', alt: '机架照片.png' }),
    ).toBe('机架照片.png');
  });

  test('取 src 的 URL 末段并做 URL 解码', () => {
    expect(
      downloadFileName({
        src: '/api/files/%E6%9C%BA%E6%9E%B6%E7%85%A7%E7%89%87.jpg',
        alt: '',
      }),
    ).toBe('机架照片.jpg');
    expect(
      downloadFileName({
        src: 'https://cdn.example.com/files/%E6%9C%BA%E6%9E%B6%E7%85%A7%E7%89%87.png',
        alt: '',
      }),
    ).toBe('机架照片.png');
  });

  test('query 与 hash 不影响文件名', () => {
    expect(
      downloadFileName({ src: '/api/files/a.png?token=1#frag', alt: '' }),
    ).toBe('a.png');
  });

  test('缺扩展名时补 .png', () => {
    expect(downloadFileName({ src: '/api/files/photo', alt: '' })).toBe(
      'photo.png',
    );
    expect(
      downloadFileName({ src: 'https://cdn.example.com/download', alt: '' }),
    ).toBe('download.png');
  });

  test('剔除路径分隔符与控制字符', () => {
    expect(
      downloadFileName({ src: '/x.png', alt: 'a/b\\c\u0001d.png' }),
    ).toBe('abcd.png');
  });

  test('空 src 或空白 alt 兜底 image.png，空白 alt 回退 src 末段', () => {
    expect(downloadFileName({ src: '', alt: '' })).toBe('image.png');
    expect(downloadFileName({ src: '   ', alt: '  ' })).toBe('image.png');
    expect(
      downloadFileName({
        src: '/api/files/%E6%9C%BA%E6%9E%B6%E7%85%A7%E7%89%87.png?x=1',
        alt: '   ',
      }),
    ).toBe('机架照片.png');
  });
});
