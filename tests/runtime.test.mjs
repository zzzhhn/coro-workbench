import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { publishScore } from '../scripts/audition-score.mjs';
import { backendMismatch, corePorts, runtimeIdentity, supportedNode } from '../scripts/runtime.mjs';

test('rejects wrong workspace, stale source and legacy unidentified servers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'coro-runtime-'));
  try {
    mkdirSync(path.join(root, 'server'));
    writeFileSync(path.join(root, 'server/app.py'), 'before');
    const identity = runtimeIdentity(root);
    const health = { localOnly: true, engines: { basicPitch: {} }, runtime: identity };
    assert.equal(backendMismatch(health, identity), undefined);
    assert.match(backendMismatch({ ...health, runtime: undefined }, identity), /无法确认/);
    assert.match(backendMismatch(health, { ...identity, workspaceId: 'elsewhere' }), /另一份/);
    writeFileSync(path.join(root, 'server/app.py'), 'after');
    assert.match(backendMismatch(health, runtimeIdentity(root)), /旧版本/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('matches installed Vite and Vitest Node requirements', () => {
  for (const version of ['22.12.0', '22.18.0', '24.0.0', '26.0.0'])
    assert.equal(supportedNode(version), true);
  for (const version of ['20.19.0', '22.11.0', '23.0.0', '25.5.0'])
    assert.equal(supportedNode(version), false);
});

test('defaults to the formal ports and accepts per-worktree overrides', () => {
  assert.deepEqual(corePorts({}), { backend: 8765, frontend: 5173 });
  assert.deepEqual(corePorts({ CORO_BACKEND_PORT: '8775', CORO_FRONTEND_PORT: '5183' }), { backend: 8775, frontend: 5183 });
  assert.throws(() => corePorts({ CORO_BACKEND_PORT: '80' }), /Invalid Coro port/);
});

test('audition publishing audits timing before staging and preserves older versions', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'coro-audition-'));
  t.after(() => rmSync(root, { recursive: true }));
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, ws: false },
  });
  t.after(() => vite.close());

  const { createBlankProject } = await vite.ssrLoadModule('/src/lib/demo.ts');
  const project = createBlankProject();
  project.measures = 1;
  project.parts[0].notes = [
    { id: 'quarter', midi: 60, start: 0, duration: 1, velocity: 0.8, articulation: 'staccato' },
    { id: 'arpeggio-low', midi: 62, start: 1, duration: 1, velocity: 0.8, arpeggio: true },
    { id: 'arpeggio-high', midi: 65, start: 1, duration: 1, velocity: 0.8, arpeggio: true },
  ];
  project.parts.push({
    ...project.parts[0],
    id: 'voice-percussion',
    role: 'percussion',
    clef: 'percussion',
    notes: [36, 42, 27].map((midi, start) => ({
      id: `drum-${midi}`, midi, start, duration: 1, velocity: 0.8, articulation: 'staccato',
    })),
  });
  let xml;
  let exportCount = 0;
  const loader = (changeXml) => ({
    async ssrLoadModule(id) {
      const module = await vite.ssrLoadModule(id);
      if (id !== '/src/lib/music.ts') return module;
      return {
        ...module,
        toMusicXml(project) {
          exportCount++;
          xml = changeXml(module.toMusicXml(project));
          return xml;
        },
      };
    },
  });

  const published = path.join(root, 'fresh');
  await publishScore(loader((score) => score), published, project, project, {});
  assert.equal(exportCount, 1);
  assert.equal(await readFile(path.join(published, 'score.musicxml'), 'utf8'), xml);

  const invalid = path.join(root, 'uncreated', 'bad');
  const wrongBeat = loader((score) => {
    assert.ok(score.includes('<duration>960</duration>'));
    return score.replace('<duration>960</duration>', '<duration>480</duration>');
  });
  await assert.rejects(publishScore(wrongBeat, invalid, project, project, {}), /xml-measure-clock/);
  assert.equal(exportCount, 2);
  await assert.rejects(access(path.dirname(invalid)), { code: 'ENOENT' });

  const legacy = path.join(root, 'legacy');
  const legacyXml = path.join(legacy, 'score.musicxml');
  mkdirSync(legacy);
  writeFileSync(legacyXml, xml);
  await assert.rejects(publishScore(wrongBeat, legacy, project, project, {}), /试听目录已存在/);
  assert.equal(exportCount, 2);
  assert.equal(await readFile(legacyXml, 'utf8'), xml);
});
