import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
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

const backend = await probe('http://127.0.0.1:8765/api/health');
if (backend) {
  const health = await backend.json().catch(() => null);
  if (!health?.localOnly || !health?.engines?.basicPitch) {
    console.error('Port 8765 belongs to another application. Nothing was stopped.');
    process.exit(1);
  }
  console.log('Using existing Coro audio engine on 8765. Restart it if you just updated backend code.');
} else run(python, ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '8765']);

const frontend = await probe('http://127.0.0.1:5173/');
if (frontend) {
  const html = await frontend.text();
  if (!html.includes('Coro')) {
    console.error('Port 5173 belongs to another application. Nothing was stopped.');
    close(1);
  } else console.log('Using existing Coro workbench on 5173.');
} else
  run(process.execPath, [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    '5173',
    '--strictPort',
  ]);

if (!closing) {
  console.log(
    '\nCoro workbench: http://127.0.0.1:5173/\nLocal-only. Keep this terminal open. Ctrl+C stops only processes started here.\n',
  );
  setInterval(() => {}, 60000);
}
