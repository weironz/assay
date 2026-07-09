/** 深色模式管理：初始化 + 切换，持久化到 localStorage */

export function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** 应用启动时调用：读 localStorage，无则跟随系统 */
export function initTheme() {
  const saved = localStorage.getItem('theme');
  const dark =
    saved === 'dark' ||
    (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
