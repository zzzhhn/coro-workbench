import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export function privateFileDeny(root: string) {
  const base = normalizePath(root).replace(/\/$/, '');
  // Vite matches absolute paths: **/work/** would block the entire checkout
  // under GitHub's /home/runner/work, or any similarly named parent folder.
  const escaped = base.replace(/([*?\[\]{}()!+@])/g, '\\$1');
  return [
    '.env', '.env.*', '*.{crt,pem}', '**/.git/**',
    ...['models', '.venv*', 'data', 'evidence', 'server', 'work', 'audio']
      .map((directory) => `${escaped}/${directory}/**`),
  ];
}

const backend = `http://127.0.0.1:${process.env.CORO_BACKEND_PORT ?? 8765}`;
// Worktrees share one linked node_modules; keep each instance's dep cache apart.
const frontendPort = process.env.CORO_FRONTEND_PORT;

export default defineConfig({
  plugins: [react()],
  ...(frontendPort && frontendPort !== '5173' ? { cacheDir: `node_modules/.vite-${frontendPort}` } : {}),
  server: {
    proxy: { '/api': backend },
    watch: { ignored: ['**/models/**', '**/.venv/**', '**/data/**', '**/evidence/**'] },
    fs: {
      deny: privateFileDeny(fileURLToPath(new URL('.', import.meta.url))),
    },
  },
  preview: { proxy: { '/api': backend } },
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
