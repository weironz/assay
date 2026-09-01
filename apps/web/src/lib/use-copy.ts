import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 复制到剪贴板，返回「刚刚复制成功」的短暂状态供界面提示。
 *
 * navigator.clipboard 只在安全上下文（https / localhost）可用。内网用 http
 * 访问时它是 undefined，所以保留 execCommand 兜底——虽然已废弃，但仍是
 * 非安全上下文下唯一能用的路径。
 */
export function useCopy(resetAfterMs = 1800) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载后别再 setState，否则控制台会报更新已卸载组件
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      // 先试现代 API，失败再退回 execCommand。注意不能只判断 writeText 是否
      // 存在：它在权限被拒、文档失焦等情况下是「存在但抛异常」，只判存在会
      // 直接走进 catch，兜底路径永远轮不到。
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (!ok) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          // 放到视口外，避免复制瞬间页面跳动
          ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch {
          ok = false;
        }
      }
      if (ok) {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetAfterMs);
      }
      return ok;
    },
    [resetAfterMs],
  );

  return { copy, copied };
}
