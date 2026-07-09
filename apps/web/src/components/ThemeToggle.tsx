import { useState } from 'react';
import { applyTheme, isDark } from '../lib/theme';

export default function ThemeToggle() {
  const [dark, setDark] = useState(isDark());
  const toggle = () => {
    const next = !dark;
    applyTheme(next);
    setDark(next);
  };
  return (
    <button
      onClick={toggle}
      title={dark ? '切换到浅色' : '切换到深色'}
      className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}
