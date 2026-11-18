import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // 本地调试可设 AKM_API_PROXY 指到别的后端，默认本地服务
      '/api': process.env.AKM_API_PROXY || 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
