import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { initI18n } from './i18n';
import { initTheme } from './lib/theme';

initTheme();

// 首帧等活跃语言包就位（en 是静态打包的 no-op），避免闪现原始键名
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
