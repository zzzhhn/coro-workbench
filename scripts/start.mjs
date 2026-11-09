import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendMismatch, corePorts, runtimeIdentity, supportedNode } from './runtime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
const ports = corePorts();
if (!supportedNode(process.version)) {
  console.error('Unsupported Node.js version. Use the version in .nvmrc, then run npm run doctor.');
  process.exit(1);
}
let closing = false;

async function probe(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(1200) });
  } catch {
    return undefined;
  }
}

function run(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => {
    console.error(error.message);
    close(1);
  });
  child.on('exit', (code) => {
    if (!closing) close(code ?? 1);
  });
  return child;
}

function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 600).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close());

const python = path.join(root, '.venv', 'bin', 'python');
if (!existsSync(path.join(root, 'node_modules', 'vite'))) {
  console.error('Frontend dependencies are missing. Run npm ci first.');
  process.exit(1);
}
if (!existsSync(python)) {
  console.error(
    'Audio runtime is missing. Run ./scripts/setup-audio.sh first.\nFor score-only use: npm run dev',
  );
  process.exit(1);
}

const backend = await probe(`http://127.0.0.1:${ports.backend}/api/health`);
if (backend) {
  const health = await backend.json().catch(() => null);
  const mismatch = backendMismatch(health, runtimeIdentity(root));
  if (mismatch) {
    console.error(`${mismatch}。等待当前任务结束后手动重启；没有停止任何现有进程。`);
    process.exit(1);
  }
  console.log(`Using existing Coro audio engine with matching source on ${ports.backend}.`);
} else run(python, ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', String(ports.backend)]);

const frontend = await probe(`http://127.0.0.1:${ports.frontend}/`);
if (frontend) {
  const html = await frontend.text();
  if (!html.includes('Coro')) {
    console.error(`Port ${ports.frontend} belongs to another application. Nothing was stopped.`);
    close(1);
  } else console.log(`Using existing Coro workbench on ${ports.frontend}.`);
} else
  run(process.execPath, [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    String(ports.frontend),
    '--strictPort',
  ]);

if (!closing) {
  console.log(
    `\nCoro workbench: http://127.0.0.1:${ports.frontend}/\nLocal-only. Keep this terminal open. Ctrl+C stops only processes started here.\n`,
  );
  setInterval(() => {}, 60000);
}
