#!/usr/bin/env node
/** Sequential, reproducible auditions. Usage: node scripts/render-auditions.mjs OUTPUT_DIR [OUTPUT_DIR...]
 * Each directory supplies arrangement.json; no uncompressed audio is persisted.
 */
import { readFile, writeFile, rm, readdir, access, link, copyFile, statfs } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { freemem, totalmem } from 'node:os';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererURL = new URL(process.env.AUDITION_ORIGIN ?? 'http://127.0.0.1:5173');
if (rendererURL.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(rendererURL.hostname) || rendererURL.username || rendererURL.password || rendererURL.search || rendererURL.hash || rendererURL.pathname !== '/')
  throw new Error('AUDITION_ORIGIN must be a loopback HTTP origin (127.0.0.1, localhost, or ::1), without credentials or a path');
const origin = rendererURL.origin;
const sampleRate = 44100;
const auditionNames = ['mix', 'solo', 's', 'a', 't', 'b'];
const target = { integratedLUFS: -23, limiterTruePeakDBTP: -2, acceptedTruePeakDBTP: -1.5, loudnessToleranceLU: .25 };
const samplerSourceSHA256 = createHash('sha256').update(await readFile(join(root, 'src/lib/audio.ts'))).digest('hex');
const choirBankSHA256 = createHash('sha256').update(await readFile(join(root, 'public/soundfonts/choir_aahs.json'))).digest('hex');
const rendererSignature = createHash('sha256').update(await Promise.all(['audio.ts', 'dynamics.ts', 'performance.ts'].map(f => readFile(join(root, 'src/lib', f)))).then(parts => Buffer.concat(parts))).digest('hex');
const renderCache = new Map();
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const excludes = new Set(args.filter(a => a.startsWith('--exclude=')).map(a => a.slice('--exclude='.length)));
const compatibleRendererHashes = new Set((process.env.AUDITION_COMPATIBLE_RENDERER_SHA256 ?? '').split(',').filter(Boolean));
const cacheRoots = args.filter(a => a.startsWith('--cache-root=')).map(a => resolve(a.slice('--cache-root='.length)));
const directories = args.filter(p => !p.startsWith('--')).map(p => resolve(p));
if (!directories.length) throw new Error('Usage: node scripts/render-auditions.mjs [--watch] [--exclude=DIR_NAME] [--cache-root=DIR] OUTPUT_DIR [OUTPUT_DIR...]');

function assertChoirProject(project) {
  if (!Array.isArray(project.parts) || !project.parts.length) throw new Error('The audition requires choir parts');
  for (const part of project.parts) {
    const vocalName = part.role !== 'instrument' && part.role !== 'percussion' && /voice|choir/i.test(part.instrument);
    if (part.role === 'percussion' || !(vocalName || part.program >= 52 && part.program <= 54))
      throw new Error(`Only choir_aahs auditions are supported; ${part.id} requests another soundbank. Its bank is not fingerprinted.`);
  }
}

async function alreadyRendered(directory) {
  try {
    const previous = JSON.parse(await readFile(join(directory, 'audio.json'), 'utf8'));
    const projectJSON = await readFile(join(directory, 'arrangement.json'), 'utf8');
    assertChoirProject(JSON.parse(projectJSON));
    const hash = createHash('sha256').update(projectJSON).digest('hex');
    if (previous.arrangementSHA256 !== hash || previous.files.length !== 6 || previous.renderingCodeSignature !== rendererSignature || previous.choirBankSHA256 !== choirBankSHA256) return false;
    if (!auditionNames.every(name => previous.files.some(file => file.name === name && file.file === `${name}.m4a`))) return false;
    if (previous.sampleRate !== sampleRate || !Object.entries(target).every(([key, value]) => previous.target?.[key] === value)) return false;
    await Promise.all(previous.files.map(async f => {
      const digest = createHash('sha256').update(await readFile(join(directory, f.file))).digest('hex');
      if (!f.SHA256 || f.SHA256 !== digest) throw new Error('Output audio hash changed');
    }));
    return true;
  } catch { return false; }
}
async function* readyDirectories() {
  if (!watch) {
    for (const directory of directories) if (!excludes.has(directory.split('/').at(-1)) && !(await alreadyRendered(directory))) yield directory;
    return;
  }
  const seen = new Set();
  async function scan(directory, depth = 0) {
    if (depth > 4) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(e => e.name === 'arrangement.json')) return [directory];
    return (await Promise.all(entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => scan(join(directory, e.name), depth + 1)))).flat();
  }
  while (true) {
    for (const base of directories) {
      try { await access(join(base, '.audio-stop')); return; } catch {}
      for (const directory of await scan(base)) {
        try { await access(join(base, '.audio-stop')); return; } catch {}
        if (excludes.has(directory.split('/').at(-1))) continue;
        if (seen.has(directory) || await alreadyRendered(directory)) continue;
        try { JSON.parse(await readFile(join(directory, 'arrangement.json'), 'utf8')); } catch { continue; }
        yield directory;
        seen.add(directory);
      }
    }
    await new Promise(done => setTimeout(done, 1500));
  }
}

async function ffmpeg(args) {
  const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '1', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-24000); });
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(-4000)}`);
  return stderr;
}
function loudnessReport(text) {
  const matches = [...text.matchAll(/\{\s*"input_i"[\s\S]*?\}/g)];
  if (!matches.length) throw new Error('No loudness report');
  return JSON.parse(matches.at(-1)[0]);
}
async function measure(path) {
  const log = await ffmpeg(['-i', path, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']);
  return ebur128Report(log);
}
function ebur128Report(text) {
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const input_i = /\bI:\s*(-?[\d.]+)\s+LUFS/.exec(summary)?.[1];
  const input_lra = /\bLRA:\s*([\d.]+)\s+LU/.exec(summary)?.[1];
  const input_tp = /\bPeak:\s*(-?[\d.]+)\s+dBFS/.exec(summary)?.[1];
  if (![input_i, input_lra, input_tp].every(v => v !== undefined && Number.isFinite(Number(v)))) throw new Error(`No valid EBU R128 measurement: ${summary}`);
  return { input_i, input_lra, input_tp };
}
async function normalize(raw, output, input) {
  if (!Number.isFinite(Number(input.input_i))) throw new Error(`Silent/invalid render: ${raw}`);
  const gain = target.integratedLUFS - Number(input.input_i);
  const projectedTruePeak = Number(input.input_tp) + gain;
  let filter = `volume=${gain.toFixed(3)}dB`;
  let normalization = 'single linear gain from concurrent lossless PCM EBU R128 measurement; AAC 192 kb/s';
  // Common choir auditions have ample headroom. Only genuinely peak-limited
  // material pays for the full oversampled loudnorm limiter.
  if (projectedTruePeak > target.limiterTruePeakDBTP) {
    const measurement = loudnessReport(await ffmpeg(['-i', raw, '-af', 'loudnorm=I=-23:TP=-2:LRA=50:print_format=json', '-f', 'null', '-']));
    filter = `loudnorm=I=-23:TP=-2:LRA=50:measured_I=${measurement.input_i}:measured_TP=${measurement.input_tp}:measured_LRA=${measurement.input_lra}:measured_thresh=${measurement.input_thresh}:offset=${measurement.target_offset}:linear=true:print_format=json`;
    normalization = 'two-pass loudnorm peak-limited fallback; AAC 192 kb/s';
  }
  await ffmpeg(['-y', '-i', raw, '-af', filter, '-c:a', 'aac', '-b:a', '192k', '-ar', `${sampleRate}`, '-movflags', '+faststart', output]);
  const final = await measure(output);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,sample_rate,channels', '-of', 'json', output], { encoding: 'utf8' }));
  const metrics = { file: output.split('/').at(-1), integratedLUFS: Number(final.input_i), truePeakDBTP: Number(final.input_tp), loudnessRangeLU: Number(final.input_lra), durationSeconds: Number(probe.format.duration), bytes: Number(probe.format.size), stream: probe.streams[0], rawIntegratedLUFS: Number(input.input_i), rawTruePeakDBTP: Number(input.input_tp), normalization, linearGainDB: gain };
  metrics.SHA256 = createHash('sha256').update(await readFile(output)).digest('hex');
  if (Math.abs(metrics.integratedLUFS - target.integratedLUFS) > target.loudnessToleranceLU || metrics.truePeakDBTP > target.acceptedTruePeakDBTP)
    throw new Error(`Final loudness outside tolerance: ${JSON.stringify(metrics)}`);
  return metrics;
}
function partFor(project, label) {
  if (label === 'solo') return project.parts.find(p => p.id === 'solo') ?? project.parts.find(p => p.role === 'lead');
  return project.parts.find(p => p.id === `voice-${label}`) ?? project.parts.find(p => p.shortName.replace(/[.\s]/g, '').toLowerCase() === label);
}

function renderingSignature(project, ids) {
  const relevantNotes = ['midi', 'start', 'duration', 'velocity', 'articulation', 'dynamic', 'dynamicScope', 'arpeggio', 'arpeggioOffset', 'staff', 'voice'];
  const signature = { rendererSignature, choirBankSHA256, tempo: project.tempo, timeSignature: project.timeSignature, measures: project.measures,
    parts: project.parts.filter(p => !ids || ids.includes(p.id)).map(p => ({ instrument: p.instrument, program: p.program, role: p.role, volume: p.volume, pan: p.pan ?? 0, pedals: p.pedals, pedalSustain: p.pedalSustain,
      notes: p.notes.map(n => Object.fromEntries(relevantNotes.filter(k => n[k] !== undefined).map(k => [k, n[k]]))) })) };
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex');
}

async function collectCache(directory, depth = 0) {
  if (depth > 5) return;
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(e => e.name === 'audio.json')) {
    try {
      const audio = JSON.parse(await readFile(join(directory, 'audio.json'), 'utf8'));
      const projectJSON = await readFile(join(directory, 'arrangement.json'), 'utf8');
      const project = JSON.parse(projectJSON);
      assertChoirProject(project);
      if (createHash('sha256').update(projectJSON).digest('hex') !== audio.arrangementSHA256) throw new Error('Prior audio belongs to another arrangement');
      if (audio.sampleRate !== sampleRate || !Object.entries(target).every(([key, value]) => audio.target?.[key] === value)) throw new Error('Prior audio used different audition settings');
      if (audio.choirBankSHA256 !== choirBankSHA256 && !(audio.choirBankSHA256 === undefined && compatibleRendererHashes.has(audio.rendererSHA256))) throw new Error('Prior soundbank fingerprint is missing or changed');
      // Import older validated outputs only under an identical sampler SHA or
      // an explicitly supplied source-equivalence receipt.
      if ((!audio.renderingCodeSignature || compatibleRendererHashes.has(audio.rendererSHA256)) && (audio.rendererSHA256 === samplerSourceSHA256 || compatibleRendererHashes.has(audio.rendererSHA256)) && audio.files.every(f => f.sourceRender?.frames > 0)) {
        if (audio.choirBankSHA256 && audio.choirBankSHA256 !== choirBankSHA256) throw new Error('Prior audio used another choir bank');
        for (const entry of audio.files) entry.renderingSignature = renderingSignature(project, entry.name === 'mix' ? undefined : entry.partIds);
        audio.renderingCodeSignature = rendererSignature;
        audio.choirBankSHA256 = choirBankSHA256;
        for (const entry of audio.files) entry.SHA256 = createHash('sha256').update(await readFile(join(directory, entry.file))).digest('hex');
        audio.compatibilityReceipt = audio.rendererSHA256 === samplerSourceSHA256 ? 'Identical source SHA256' : 'Caller explicitly supplied this prior sampler SHA256 as audibly equivalent; original provenance retained';
        await writeFile(join(directory, 'audio.json'), JSON.stringify(audio, null, 2) + '\n');
      }
      if (audio.renderingCodeSignature === rendererSignature)
        for (const entry of audio.files) if (entry.renderingSignature && entry.SHA256) {
          const path = join(directory, entry.file);
          if (createHash('sha256').update(await readFile(path)).digest('hex') === entry.SHA256) renderCache.set(entry.renderingSignature, { path, metrics: entry });
        }
    } catch {}
  }
  for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await collectCache(join(directory, entry.name), depth + 1);
}
for (const cacheRoot of cacheRoots.length ? cacheRoots : directories) await collectCache(cacheRoot).catch(() => {});
if (!watch) for (const directory of directories) {
  if (!excludes.has(directory.split('/').at(-1))) assertChoirProject(JSON.parse(await readFile(join(directory, 'arrangement.json'), 'utf8')));
}

// This is a task-owned offscreen functional test context, never a user profile/tab.
const fsState = await statfs(root);
const preflight = process.env.AUDITION_PREFLIGHT_SCRIPT
  ? JSON.parse(execFileSync(process.env.AUDITION_PREFLIGHT_PYTHON ?? 'python3', [process.env.AUDITION_PREFLIGHT_SCRIPT], { encoding: 'utf8' }))
  : { disk_free_gib: Number(fsState.bavail) * Number(fsState.bsize) / 1024 ** 3, free_memory_gib: freemem() / 1024 ** 3, total_memory_gib: totalmem() / 1024 ** 3, heavy_work_policy: 'serialized; native memory-pressure/swap checks are caller responsibility' };
console.log(JSON.stringify({ event: 'preflight', ...preflight }));
const executablePath = process.env.AUDITION_BROWSER_EXECUTABLE;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }), args: ['--disable-extensions', '--disable-gpu', '--js-flags=--expose-gc'] });
const runtime = { browser: browser.version(), node: process.version, ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0] };
let encoder;
let pcmHash;
let uploadOrigin;
const uploadToken = randomBytes(24).toString('hex');
const uploadServer = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Task-owned offscreen audio rendering</title>'); return;
  }
  if (request.method === 'GET' && request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.method === 'GET' && /^\/soundfonts\/[a-z0-9_]+\.json$/.test(request.url ?? '')) {
    try {
      const asset = await fetch(`${origin}${request.url}`);
      response.writeHead(asset.status, { 'Content-Type': 'application/json' }).end(Buffer.from(await asset.arrayBuffer()));
    } catch { response.writeHead(502).end(); }
    return;
  }
  if (process.env.AUDITION_DEBUG) console.log(JSON.stringify({ event: 'pcm-request', method: request.method, origin: request.headers.origin, pathMatches: request.url === `/pcm/${uploadToken}` }));
  if (request.url !== `/pcm/${uploadToken}` || request.headers.origin !== uploadOrigin) { response.writeHead(403).end(); return; }
  response.setHeader('Access-Control-Allow-Origin', uploadOrigin);
  response.setHeader('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'POST');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.writeHead(204).end(); return;
  }
  if (request.method !== 'POST' || !encoder?.stdin) { response.writeHead(409).end(); return; }
  try {
    for await (const bytes of request) {
      pcmHash?.update(bytes);
      if (!encoder.stdin.write(bytes)) await once(encoder.stdin, 'drain');
    }
    response.writeHead(204).end();
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(done => uploadServer.listen(0, '127.0.0.1', done));
uploadOrigin = `http://127.0.0.1:${uploadServer.address().port}`;
const uploadURL = `${uploadOrigin}/pcm/${uploadToken}`;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (process.env.AUDITION_DEBUG) page.on('console', message => { if (message.type() === 'error') console.log(message.text().replace(/\/pcm\/[a-f0-9]+/g, '/pcm/[nonce]')); });
  await page.goto(`${uploadOrigin}/`);
  await page.evaluate(async url => { window.auditionModule = await import(url); }, `${origin}/src/lib/audio.ts`);
  if (args.includes('--verify-buffer')) {
    const fixture = JSON.parse(await readFile(join(directories[0], 'arrangement.json'), 'utf8'));
    const verification = await page.evaluate(async project => {
      const module = window.auditionModule;
      const buffer = await module.renderProjectAudioBuffer(project);
      const expected = module.encodeWav(buffer);
      const wrapped = await module.renderProjectAudio(project);
      const equal = expected.length === wrapped.bytes.length && expected.every((value, index) => value === wrapped.bytes[index]);
      let maximumSampleDifference = 0, squareError = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const a = buffer.getChannelData(channel), b = wrapped.buffer.getChannelData(channel);
        for (let frame = 0; frame < a.length; frame++) { const d = a[frame] - b[frame]; maximumSampleDifference = Math.max(maximumSampleDifference, Math.abs(d)); squareError += d * d; }
      }
      return { bufferWrapperWAVByteIdentical: equal, maximumSampleDifference, rmsSampleDifference: Math.sqrt(squareError / (buffer.length * buffer.numberOfChannels)), bytes: expected.length, frames: buffer.length, durationSeconds: buffer.duration };
    }, fixture);
    console.log(JSON.stringify({ event: 'buffer-api-verified', ...verification }));
    if (verification.maximumSampleDifference > .00001) throw new Error('Buffer API comparison exceeds -100 dBFS sample tolerance');
  }
  for await (const directory of readyDirectories()) {
    const arrangementPath = join(directory, 'arrangement.json');
    const json = await readFile(arrangementPath, 'utf8');
    const project = JSON.parse(json);
    assertChoirProject(project);
    const banks = await page.evaluate(project => project.parts.map(part => window.auditionModule.sampleBankFor(part)), project);
    if (banks.some(bank => bank !== 'choir_aahs')) throw new Error('Official sampler selected a non-choir soundbank; refusing an incomplete bank fingerprint');
    const expectedDuration = project.measures * project.timeSignature[0] * 4 / project.timeSignature[1] * 60 / project.tempo + .75;
    const results = [];
    for (const name of auditionNames) {
      const part = name === 'mix' ? undefined : partFor(project, name);
      if (name !== 'mix' && !part) throw new Error(`Missing ${name} part in ${directory}`);
      const selectedIds = part ? [part.id] : undefined;
      const signature = renderingSignature(project, selectedIds);
      const raw = join(directory, `.${name}.raw.flac`);
      const output = join(directory, `${name}.m4a`);
      const cached = renderCache.get(signature);
      if (cached && cached.path !== output) {
        await rm(output, { force: true });
        try { await link(cached.path, output); } catch { await copyFile(cached.path, output); }
        const metrics = { ...cached.metrics, name, file: `${name}.m4a`, partIds: part ? [part.id] : project.parts.map(p => p.id), reusedFrom: cached.path, renderingSignature: signature };
        results.push(metrics);
        console.log(JSON.stringify({ event: 'reused', directory, name, from: cached.path }));
        continue;
      }
      let encoderLog = '';
      pcmHash = createHash('sha256');
      console.log(JSON.stringify({ event: 'render', directory, name, expectedDuration }));
      encoder = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-threads', '1', '-f', 'f32le', '-ar', `${sampleRate}`, '-ac', '2', '-i', 'pipe:0', '-af', 'ebur128=peak=true:framelog=verbose', '-c:a', 'flac', '-compression_level', '0', raw], { stdio: ['pipe', 'ignore', 'pipe'] });
      encoder.stderr.on('data', data => { encoderLog = (encoderLog + data).slice(-4000); });
      const completed = once(encoder, 'close');
      const rendered = await page.evaluate(async ({ project, ids, uploadURL }) => {
        const buffer = await window.auditionModule.renderProjectAudioBuffer(project, ids);
        const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
        let peak = 0, sum = 0;
        const framesPerChunk = 44100 * 4;
        for (let from = 0; from < buffer.length; from += framesPerChunk) {
          const count = Math.min(framesPerChunk, buffer.length - from);
          const pcm = new Float32Array(count * 2);
          for (let i = 0; i < count; i++) {
            const l = left[from + i], r = right[from + i];
            pcm[i * 2] = l; pcm[i * 2 + 1] = r;
            peak = Math.max(peak, Math.abs(l), Math.abs(r)); sum += l * l + r * r;
          }
          const response = await fetch(uploadURL, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.buffer });
          if (!response.ok) throw new Error(`PCM transfer rejected (${response.status})`);
        }
        return { durationSeconds: buffer.duration, frames: buffer.length, peak, rms: Math.sqrt(sum / (buffer.length * 2)) };
      }, { project, ids: part ? [part.id] : undefined, uploadURL });
      encoder.stdin.end();
      const [code] = await completed;
      encoder = undefined;
      rendered.PCMFloat32SHA256 = pcmHash.digest('hex');
      pcmHash = undefined;
      if (code !== 0) throw new Error(`PCM encoding failed: ${encoderLog}`);
      await page.evaluate(() => { if (typeof window.gc === 'function') window.gc(); });
      if (rendered.peak <= .00001 || Math.abs(rendered.durationSeconds - expectedDuration) > .001) throw new Error(`Invalid render ${name}: ${JSON.stringify(rendered)}`);
      const rawMeasurement = ebur128Report(encoderLog);
      const metrics = await normalize(raw, output, rawMeasurement);
      if (Math.abs(metrics.durationSeconds - expectedDuration) > .1) throw new Error(`Truncated encoded file: ${output}`);
      await rm(raw);
      const entry = { name, partIds: part ? [part.id] : project.parts.map(p => p.id), ...metrics, sourceRender: rendered, renderingSignature: signature };
      results.push(entry);
      renderCache.set(signature, { path: output, metrics: entry });
      console.log(JSON.stringify({ event: 'complete', directory, name, LUFS: metrics.integratedLUFS, truePeak: metrics.truePeakDBTP, duration: metrics.durationSeconds }));
    }
    const manifest = {
      version: 1, generatedAt: new Date().toISOString(), arrangementSHA256: createHash('sha256').update(json).digest('hex'),
      renderer: 'Official src/lib/audio.ts renderProjectAudioBuffer via task-owned offscreen Chromium; direct buffer API, unchanged complete-score scheduling',
      rendererSHA256: samplerSourceSHA256, renderingCodeSignature: rendererSignature, choirBankSHA256, runtime,
      measurementMethod: 'FFmpeg ebur128=peak=true integrated EBU R128 and oversampled true peak', sampleRate, channels: 2, target,
      expectedDurationSeconds: expectedDuration, heldNoteContinuity: 'Full-score single render per file; no window cropping, re-attacks, or concatenation',
      memoryPolicy: 'One complete-score AudioBuffer at a time; 4-second binary loopback PCM transfers with encoder backpressure; transient lossless FLAC with concurrent EBU R128 measurement, removed after AAC validation; decoded sample banks reused',
      preflight, files: results,
    };
    await writeFile(join(directory, 'audio.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
} finally {
  encoder?.kill('SIGTERM');
  await browser.close();
  await new Promise(done => uploadServer.close(done));
}
