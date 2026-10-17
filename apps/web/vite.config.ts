import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 第三方依赖单独成块：业务代码改动后用户只需重新下载应用 chunk，
        // vendor 命中浏览器 30 天 immutable 缓存。exceljs 已由业务代码
        // 动态 import 懒加载，保持 rollup 自动分块不被并回 vendor。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('exceljs')) return undefined;
          return 'vendor';
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: {
      // 挂载卷在部分平台需轮询才能热更新
      usePolling: true,
    },
  },
});
