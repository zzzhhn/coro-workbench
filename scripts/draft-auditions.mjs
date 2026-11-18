// node scripts/draft-auditions.mjs PRIVATE_CORPUS.json OUTPUT_DIR [dev-id ...]
// Writes local audition materials only. Held-out entries are metadata here.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'vite';
import { checkFreeze } from './audition-freeze.mjs';
import { publishScore } from './audition-score.mjs';

const [corpusPath, outputDir, ...requested] = process.argv.slice(2);
if (!corpusPath || !outputDir)
  throw Error('Expected corpus.json, output directory and optional development IDs');
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const records = [...corpus.dev, ...corpus.holdout];
for (const key of ['id', 'workId']) {
  if (records.some((r) => !r[key]) || new Set(records.map((r) => r[key])).size !== records.length)
    throw Error('Each composition must be assigned to exactly one split: ' + key);
}
const sealed = requested[0] === '--frozen';
let freeze;
if (sealed) {
  if (requested.length !== 2)
    throw Error('--frozen requires exactly one freeze receipt. All holdouts are evaluated together.');
  freeze = JSON.parse(await readFile(requested[1], 'utf8'));
  await checkFreeze(freeze, corpus);
}
if (!sealed && requested.some((id) => !corpus.dev.some((r) => r.id === id)))
  throw Error('Only development works can be rendered without a freeze.');
const drafts = sealed
  ? corpus.holdout
  : corpus.dev.filter((r) => !requested.length || requested.includes(r.id));
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
try {
  const { importScoreFile } = await vite.ssrLoadModule('/src/lib/import.ts');
  const { generateArrangementVersion } = await vite.ssrLoadModule('/src/lib/arrangementVersions.ts');
  const { beatsPerBar, validateProject } = await vite.ssrLoadModule('/src/lib/music.ts');
  for (const record of drafts) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(record.id)) throw Error('Invalid development ID');
    const dir = join(
      outputDir,
      sealed && freeze.policy.mode !== 'rule' ? 'holdout-inputs' : sealed ? 'first' : 'drafts',
      record.id,
    );
    if (freeze && (!record.path || !record.sourceSha256 || !Number.isInteger(record.leadIndex)))
      throw Error('Supply admitted sources and checksums after freezing the method.');
    const sourcePath = resolve(dirname(corpusPath), record.path);
    const bytes = await readFile(sourcePath);
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    if (record.sourceSha256 && sourceSha256 !== record.sourceSha256)
      throw Error('源谱与已登记的版本不一致：' + record.id);
    if (sealed) {
      const previous = await readFile(join(dir, 'evidence.json'), 'utf8')
        .then(JSON.parse)
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      if (previous) {
        if (
          previous.sourceSha256 !== sourceSha256 ||
          previous.leadIndex !== record.leadIndex ||
          JSON.stringify(previous.freeze) !== JSON.stringify(freeze)
        )
          throw Error('已保存的留出输入与本次冻结不一致。');
        continue;
      }
    }
    const source = await importScoreFile(new File([bytes], basename(sourcePath)));
    source.title = record.title;
    const lead = source.parts[record.leadIndex];
    if (!lead || !lead.notes.some((n) => n.midi !== null)) throw Error(record.id + ': missing source melody');
    const options = {
      preset: 'solo-satb',
      engine: 'v2',
      style: 'pop',
      difficulty: 'medium',
      transpose: 0,
      percussion: false,
      leadPartId: lead.id,
    };
    const { project } = generateArrangementVersion(source, options);
    const musicalNotes = (part) => part.notes.filter((n) => n.midi !== null).map(({ id: _id, ...n }) => n);
    if (JSON.stringify(musicalNotes(project.parts[0])) !== JSON.stringify(musicalNotes(lead)))
      throw Error('Solo changed: ' + record.id);
    if (validateProject(project).length || project.parts.length !== 5)
      throw Error('Invalid draft: ' + record.id);
    const bar = beatsPerBar(source);
    const byBar = Array.from({ length: source.measures }, (_, i) => {
      const from = i * bar,
        end = from + bar;
      const attacks = (p) => p.notes.filter((n) => n.midi !== null && n.start >= from && n.start < end);
      const solo = attacks(lead);
      const sustained = lead.notes.some(
        (n) => n.midi !== null && n.start < end && n.start + n.duration > from,
      );
      const upper = project.parts.slice(1, 4).map(attacks);
      const stacked = upper[0].filter((n) =>
        upper.slice(1).every((notes) => notes.some((m) => Math.abs(n.start - m.start) < 0.02)),
      ).length;
      return {
        bar: i + 1,
        solo: solo.length,
        sustained,
        backingAttacks: upper.map((ns) => ns.length),
        together: stacked,
      };
    });
    const empty = byBar.filter((b) => !b.sustained);
    const sections = project.arrangement.plan.sections;
    const instrumentalChorus = empty.find((b) =>
      sections.some((s) => s.kind === 'chorus' && b.bar >= s.startBar && b.bar < s.startBar + s.bars),
    );
    const peak = [...byBar].sort((a, b) => b.together - a.together)[0];
    const issue = instrumentalChorus
      ? `第 ${instrumentalChorus.bar} 小节整小节没有主旋律，计划仍标为副歌。试听这一段背景有没有承担器乐段的作用。`
      : peak.together > 1
        ? `第 ${peak.bar} 小节上三部同拍重新起音 ${peak.together} 次，主旋律起音 ${peak.solo} 次。听这里的合唱重音是否遮住主线。`
        : `从第 ${sections.at(-1).startBar} 小节听尾段；最后一段沿用「${sections.at(-1).label}」计划，请判断收束是否符合原曲。`;
    const evidence = {
      id: record.id,
      title: record.title,
      sourceSha256,
      ...(freeze ? { freeze } : {}),
      sourceParts: source.parts.map((p) => p.name),
      leadIndex: record.leadIndex,
      measures: source.measures,
      meter: source.timeSignature,
      tempo: source.tempo,
      durationSeconds: (source.measures * bar * 60) / source.tempo,
      originalChords: source.chords.length,
      warnings: source.source.warnings,
      issue,
      byBar,
      sections,
      report: project.arrangement.report,
    };
    await publishScore(vite, dir, source, project, { 'source.json': source, 'evidence.json': evidence });
    console.log(
      record.id,
      source.measures,
      source.timeSignature.join('/'),
      Math.round(evidence.durationSeconds) + 's',
      issue,
    );
  }
} finally {
  await vite.close();
}
