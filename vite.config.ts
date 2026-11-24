import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/public'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('/react-dom/') ||
            id.includes('\\react-dom\\') ||
            id.includes('/react/') ||
            id.includes('\\react\\') ||
            id.includes('/scheduler/') ||
            id.includes('\\scheduler\\')
          ) {
            return 'react-vendor';
          }
          if (id.includes('/lucide-react/') || id.includes('\\lucide-react\\')) {
            return 'icons';
          }
          if (
            id.includes('/d3-') ||
            id.includes('\\d3-') ||
            id.includes('/victory-vendor/') ||
            id.includes('\\victory-vendor\\')
          ) {
            return 'd3-vendor';
          }
          if (
            id.includes('/recharts/') ||
            id.includes('\\recharts\\') ||
            id.includes('/lodash/') ||
            id.includes('\\lodash\\')
          ) {
            return 'charts';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4321',
    },
  },
});
