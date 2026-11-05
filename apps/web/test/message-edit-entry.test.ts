import { describe, expect, test } from 'bun:test';
import { canEditMessage } from '../src/lib/message-edit';

describe('#30 消息编辑入口只认作者本人', () => {
  test('作者本人：同一 id 字符串返回 true', () => {
    expect(canEditMessage('u-1', 'u-1')).toBe(true);
    expect(canEditMessage('author-42', 'author-42')).toBe(true);
    expect(canEditMessage('admin', 'admin')).toBe(true);
  });

  test('他人：不同 id 返回 false', () => {
    expect(canEditMessage('u-1', 'u-2')).toBe(false);
    expect(canEditMessage('u-2', 'u-1')).toBe(false);
  });

  test('admin/supervisor 作为额外参数场景：函数只认 id，角色不改变结果', () => {
    // 函数签名只有两个 id 参数；即便调用方额外塞入角色实参，运行时也会被忽略，
    // 结果完全由 authorId === currentUserId 决定。
    const withRole = canEditMessage as (
      authorId: string | undefined,
      currentUserId: string | undefined,
      role?: string,
    ) => boolean;
    expect(withRole('u-1', 'u-2', 'admin')).toBe(false);
    expect(withRole('u-1', 'u-2', 'supervisor')).toBe(false);
    expect(withRole('u-1', 'u-1', 'admin')).toBe(true);
    expect(withRole('u-1', 'u-1', 'supervisor')).toBe(true);

    // 不同 id 组合：两个高权限用户之间也不能互编对方的消息。
    expect(canEditMessage('u-admin', 'u-supervisor')).toBe(false);
    expect(canEditMessage('u-supervisor', 'u-admin')).toBe(false);
    expect(canEditMessage('u-author', 'u-admin')).toBe(false);
    expect(canEditMessage('u-author', 'u-supervisor')).toBe(false);
    expect(canEditMessage('u-admin', 'u-admin')).toBe(true);
    expect(canEditMessage('u-supervisor', 'u-supervisor')).toBe(true);
  });

  test('undefined / null / 空串 → false', () => {
    expect(canEditMessage(undefined, 'u-1')).toBe(false);
    expect(canEditMessage('u-1', undefined)).toBe(false);
    expect(canEditMessage(undefined, undefined)).toBe(false);
    expect(canEditMessage(null as unknown as string | undefined, 'u-1')).toBe(false);
    expect(canEditMessage('u-1', null as unknown as string | undefined)).toBe(false);
    expect(canEditMessage(null as unknown as string | undefined, null as unknown as string | undefined)).toBe(false);
    expect(canEditMessage('', 'u-1')).toBe(false);
    expect(canEditMessage('u-1', '')).toBe(false);
    expect(canEditMessage('', '')).toBe(false);
    expect(canEditMessage('', undefined)).toBe(false);
  });

  test('严格相等：大小写或前后空格不同都不放行', () => {
    expect(canEditMessage('U-1', 'u-1')).toBe(false);
    expect(canEditMessage('u-1 ', 'u-1')).toBe(false);
  });
});
