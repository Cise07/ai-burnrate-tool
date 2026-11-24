import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFallbackToolVersion(): string {
  for (const rel of ['../package.json', './package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, rel), 'utf8')) as {
        version?: string;
      };
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim().replace(/^v/i, '');
      }
    } catch {
      // try next fallback
    }
  }
  return '1.2.0';
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __TOOL_VERSION__: JSON.stringify(readFallbackToolVersion()),
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react-dom/') || id.includes('\\react-dom\\') || id.includes('/react/') || id.includes('\\react\\') || id.includes('/scheduler/') || id.includes('\\scheduler\\')) {
            return 'react-vendor';
          }
          if (id.includes('/lucide-react/') || id.includes('\\lucide-react\\')) {
            return 'icons';
          }
          if (id.includes('/d3-') || id.includes('\\d3-') || id.includes('/victory-vendor/') || id.includes('\\victory-vendor\\')) {
            return 'd3-vendor';
          }
          if (id.includes('/recharts/') || id.includes('\\recharts\\') || id.includes('/lodash/') || id.includes('\\lodash\\')) {
            return 'charts';
          }
          return undefined;
        },
      },
    },
  },
});
