import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8765' },
    watch: { ignored: ['**/models/**', '**/.venv/**', '**/data/**', '**/evidence/**'] },
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/models/**',
        '**/.venv/**',
        '**/data/**',
        '**/evidence/**',
      '**/server/**',
      '**/work/**',
      '**/audio/**',
      ],
    },
  },
  preview: { proxy: { '/api': 'http://127.0.0.1:8765' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          notation: ['abcjs'],
          music: ['@tonejs/midi', 'fast-xml-parser'],
        },
      },
    },
  },
});
