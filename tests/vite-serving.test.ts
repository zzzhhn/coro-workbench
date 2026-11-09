import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { privateFileDeny } from '../vite.config';

test('a checkout under work serves the app while private project folders stay denied', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'coro-serving-'));
  const root = join(temporary, 'work', 'checkout');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>portable checkout</h1>');
  const privatePaths = ['models/probe.txt', '.venv/probe.txt', '.venv-tests/probe.txt',
    'data/probe.txt', 'evidence/probe.txt', 'server/probe.txt', 'work/probe.txt', 'audio/probe.txt', '.env'];
  for (const path of privatePaths) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), 'synthetic private marker');
  }
  const server = await createServer({
    configFile: false, root, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [root], deny: privateFileDeny(root) } },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
    const base = `http://127.0.0.1:${address.port}`;
    const app = await fetch(base);
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('portable checkout');
    for (const path of privatePaths) {
      const response = await fetch(`${base}/${path}`);
      expect(response.status, path).toBe(403);
      expect(await response.text(), path).not.toContain('synthetic private marker');
    }
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
