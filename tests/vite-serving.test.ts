import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { privateFileDeny, servingAllowList } from '../vite.config';

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

test('a worktree with linked node_modules serves package fonts but not the main checkout', async () => {
  // macOS tmpdir is itself a symlink (/var -> /private/var); use the real path as Vite does.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'coro-linked-')));
  const main = join(temporary, 'main');
  const root = join(temporary, 'worktree');
  await mkdir(join(main, 'node_modules', 'font-pkg'), { recursive: true });
  await mkdir(join(main, 'data'), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(main, 'node_modules', 'font-pkg', 'glyph.woff2'), 'font bytes');
  await writeFile(join(main, 'data', 'private.json'), 'synthetic private marker');
  await writeFile(join(main, 'package.json'), 'main checkout');
  await writeFile(join(root, 'index.html'), '<h1>worktree</h1>');
  await symlink(join(main, 'node_modules'), join(root, 'node_modules'));
  const server = await createServer({
    configFile: false, root, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: servingAllowList(root), deny: privateFileDeny(root) } },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
    const base = `http://127.0.0.1:${address.port}/@fs`;
    const font = await fetch(`${base}${join(main, 'node_modules', 'font-pkg', 'glyph.woff2')}`);
    expect(font.status).toBe(200);
    expect(await font.text()).toBe('font bytes');
    for (const path of [join(main, 'data', 'private.json'), join(main, 'package.json')]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(403);
    }
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
