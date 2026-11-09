import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { backendMismatch, corePorts, runtimeIdentity, supportedNode } from './runtime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const full = process.argv.includes('--full');
const checks = [];
const check = (name, ok, detail, required = true) =>
  checks.push({ name, status: ok ? 'ok' : required ? 'error' : 'warning', detail });
const command = (binary, args) =>
  spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 512 * 1024 });
check(
  'Node.js',
  supportedNode(process.version),
  `${process.version}；与测试依赖兼容的版本：22.12+（22.x）、24.x 或 26+。推荐使用 .nvmrc。`,
);
check('前端依赖', existsSync(path.join(root, 'node_modules', 'vite')), '缺失时运行 npm ci。');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const pythonVersion = existsSync(python) ? command(python, ['--version']) : undefined;
check(
  'Python 音频环境',
  Boolean(pythonVersion?.status === 0 && /Python 3\.11\./.test(pythonVersion.stdout)),
  pythonVersion?.stdout.trim() || '尚未安装。音频处理需运行 bash scripts/setup-audio.sh。',
  full,
);
for (const [binary, args] of [
  ['uv', ['--version']],
  ['ffmpeg', ['-version']],
  ['ffprobe', ['-version']],
  ['pdftoppm', ['-v']],
]) {
  const result = command(binary, args);
  check(
    binary,
    result.status === 0,
    (result.stdout || result.stderr || '').split('\n')[0] || '未找到可执行文件。',
    full && ['ffmpeg', 'ffprobe'].includes(binary),
  );
}
if (pythonVersion?.status === 0) {
  const result = command(python, ['-m', 'server.runtime']);
  try {
    const installed = JSON.parse(result.stdout);
    for (const [name, engine] of Object.entries(installed.engines))
      check(
        `引擎 ${name}`,
        engine.ready === true,
        engine.ready ? '安装文件就绪；未执行模型推理。' : '未就绪，请按 docs/SETUP.md 安装对应引擎。',
        full && ['basicPitch', 'demucs', 'ffmpeg'].includes(name),
      );
  } catch {
    check('模型安装检查', false, '无法读取环境状态，请检查 .venv 的依赖；本检查没有下载或运行模型。', full);
  }
}
const expected = runtimeIdentity(root);
const ports = corePorts();
for (const [name, url] of [
  [`后端 ${ports.backend}`, `http://127.0.0.1:${ports.backend}/api/health`],
  [`前端 ${ports.frontend}`, `http://127.0.0.1:${ports.frontend}/`],
]) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (name.startsWith('后端')) {
      const health = await response.json().catch(() => null);
      const mismatch = backendMismatch(health, expected);
      check(
        name,
        !mismatch,
        mismatch
          ? `${mismatch}。${health?.activeJobs ? `还有 ${health.activeJobs} 个任务，请等任务完成。` : ''}不会自动停止服务。`
          : `运行代码与本目录一致；提交 ${health.runtime.revision ?? '未知'}。`,
      );
    } else
      check(name, response.ok && (await response.text()).includes('Coro'), '端口需为空闲或由 Coro 使用。');
  } catch (error) {
    const occupied = error?.name === 'TimeoutError';
    check(
      name,
      false,
      occupied ? '端口响应超时，请检查占用后重试。' : '服务尚未启动，可用 npm start 或 npm run dev 启动。',
      occupied,
    );
  }
}
const report = { mode: full ? 'full' : 'score', ok: !checks.some((item) => item.status === 'error'), checks };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Coro 环境自检（${full ? '完整音频工作台' : '谱面开发'}）`);
  for (const item of checks) console.log(`[${item.status.toUpperCase()}] ${item.name}：${item.detail}`);
  console.log(
    report.ok
      ? '必需检查通过；可选能力请参考上方提示。'
      : '存在需处理的问题，请修正后再次运行 npm run doctor。',
  );
}
process.exitCode = report.ok ? 0 : 1;
