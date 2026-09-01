import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyTheme, isDark } from '../lib/theme';

export default function ThemeToggle() {
  const { t } = useTranslation();
  const [dark, setDark] = useState(isDark());
  const toggle = () => {
    const next = !dark;
    applyTheme(next);
    setDark(next);
  };
  const label = dark ? t('theme.toLight') : t('theme.toDark');
  return (
    <button
      onClick={toggle}
      title={label}
      aria-label={label}
      className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}
