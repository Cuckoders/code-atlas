import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  clearScreen: false,
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1_400,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4310',
      '/v1': 'http://127.0.0.1:4310',
    },
  },
});
