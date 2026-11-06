import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data/phase5/breathing');
await mkdir(directory, { recursive: true });
await mkdir(path.join(root, 'evidence/phase5'), { recursive: true });
const sha = (data) => createHash('sha256').update(data).digest('hex');
const legacyPath = '/tmp/coro-phase2-before-a20_t98x/src/lib/arrange.ts';
const legacy = await readFile(legacyPath, 'utf8');
const runnableLegacy = path.join(directory, 'legacy-arrange.ts');
await writeFile(runnableLegacy, legacy.replaceAll("from './music'", "from '/src/lib/music'").replaceAll("from './types'", "from '/src/lib/types'"));
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });

function phrasing(part, tempo) {
  const notes = part.notes.filter((n) => n.midi !== null && n.velocity > 0).sort((a, b) => a.start - b.start);
  const spans = [];
  for (const note of notes) {
    const start = note.start * 60 / tempo, end = (note.start + note.duration) * 60 / tempo;
    const last = spans.at(-1);
    if (last && start - last[1] < .3 - 1e-7) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  return { longestSeconds: Math.max(0, ...spans.map(([a, b]) => b - a)), over10Seconds: spans.filter(([a, b]) => b - a > 10.00001).length };
}

try {
  const beforeModule = await server.ssrLoadModule(runnableLegacy);
  const afterModule = await server.ssrLoadModule('/src/lib/arrange.ts');
  const { validateProject, toMusicXml, fromMusicXml } = await server.ssrLoadModule('/src/lib/music.ts');
  const inputs = JSON.parse(await readFile(path.join(root, 'evidence/phase4/four-acoustic-songs.json'), 'utf8'));
  const report = { scope: 'Source-preserving generated-vocal breathing comparison. Physical timing heuristics, not human singing acceptance.', minimumBreathSeconds: .3,
    legacySource: legacyPath, legacySha256: sha(legacy), legacyRuntimeImportChangeOnly: true,
    currentSourceSha256: sha(await readFile(path.join(root, 'src/lib/arrange.ts'))), cases: [] };
  for (const input of inputs.results) {
    const bytes = await readFile(input.projectPath);
    const source = JSON.parse(bytes);
    for (const preset of ['satb', 'ssaa', 'ttbb']) for (const style of ['pop', 'choral']) {
      const options = { preset, style, difficulty: 'medium', percussion: true, transpose: 0, leadPartId: 'vocals' };
      const before = beforeModule.arrangeForVoices(source, options);
      const after = afterModule.arrangeForVoices(source, options);
      const errors = validateProject(after);
      if (errors.length) throw new Error(errors.join('\n'));
      const dataPath = path.join(directory, `${input.jobId}-${preset}-${style}.json`);
      await writeFile(dataPath, JSON.stringify(after));
      const voices = after.parts.filter((p) => p.role !== 'percussion').map((part) => {
        const cuts = after.arrangement.report.breathing.find((entry) => entry.partId === part.id).plannedGaps;
        for (const cut of cuts) {
          if ((cut.resumeBeat - cut.startBeat) * 60 / after.tempo < .3 - 1e-7) throw new Error('Breath too short');
          if (part.notes.some((n) => n.midi !== null && n.velocity > 0 && n.start < cut.resumeBeat - 1e-7 && n.start + n.duration > cut.startBeat + 1e-7))
            throw new Error('A note still sounds inside planned breath');
        }
        return { partId: part.id, before: phrasing(before.parts.find((p) => p.id === part.id), before.tempo), after: phrasing(part, after.tempo), insertedBreaths: cuts.length };
      });
      const sourceLead = source.parts.find((p) => p.id === 'vocals').notes.filter((n) => n.midi !== null);
      const melody = after.parts[0].notes.filter((n) => n.midi !== null);
      const retainedAttacks = sourceLead.every((note) => melody.some((n) => Math.abs(n.start - note.start) < 1e-7 && n.midi % 12 === note.midi % 12));
      if (!retainedAttacks) throw new Error('Original lead attack lost');
      const roundtrip = fromMusicXml(toMusicXml(after));
      const fingerprint = (p) => p.parts.map((part) => part.notes.filter((n) => n.midi !== null).map((n) => [n.midi, +n.start.toFixed(6), +n.duration.toFixed(6)]));
      const xmlExact = JSON.stringify(fingerprint(after)) === JSON.stringify(fingerprint(roundtrip));
      if (!xmlExact) throw new Error('MusicXML timing roundtrip changed');
      report.cases.push({ song: input.filename, preset, style, voices, retainedOriginalLeadAttacks: retainedAttacks, musicXmlExact: xmlExact,
        sourceUnchanged: JSON.stringify(source) === JSON.stringify(JSON.parse(bytes)), originalAudioUnchanged: JSON.stringify(source.originalAudio) === JSON.stringify(after.originalAudio) });
    }
    if (sha(await readFile(input.projectPath)) !== sha(bytes)) throw new Error('Source file changed');
  }
  report.allPlannedGapsActuallyEmpty = true;
  report.allSourceAttacksRetained = true;
  await writeFile(path.join(root, 'evidence/phase5/vocal-breathing.json'), JSON.stringify(report, null, 2) + '\n');
  for (const row of report.cases.filter((row) => row.preset === 'satb' && row.style === 'pop'))
    console.log(JSON.stringify({ song: row.song, voices: row.voices }));
} finally {
  await server.close();
}
