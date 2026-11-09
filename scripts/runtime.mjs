import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function runtimeIdentity(root) {
  root = realpathSync(root);
  const hash = createHash('sha256');
  for (const name of readdirSync(path.join(root, 'server'))
    .filter((name) => name.endsWith('.py'))
    .sort()) {
    hash.update(`server/${name}\0`);
    hash.update(readFileSync(path.join(root, 'server', name)));
    hash.update('\0');
  }
  return {
    workspaceId: createHash('sha256').update(root).digest('hex').slice(0, 16),
    codeHash: hash.digest('hex'),
  };
}

export function backendMismatch(health, expected) {
  if (!health?.localOnly || !health?.engines?.basicPitch) return '端口由其他服务占用';
  if (!health.runtime?.codeHash || !health.runtime?.workspaceId)
    return '后端版本无法确认，请在任务结束后手动重启旧服务';
  if (health.runtime.workspaceId !== expected.workspaceId) return '正在运行另一份检出目录的后端';
  if (health.runtime.codeHash !== expected.codeHash) return '后端代码已更新，但运行中的服务仍是旧版本';
  return undefined;
}

// Separate worktrees can run their own Coro side by side on other ports.
export function corePorts(env = process.env) {
  const parse = (value, fallback) => {
    const port = Number(value ?? fallback);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid Coro port: ${value}`);
    return port;
  };
  return { backend: parse(env.CORO_BACKEND_PORT, 8765), frontend: parse(env.CORO_FRONTEND_PORT, 5173) };
}

export function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 22 && minor >= 12) || major === 24 || major >= 26;
}
