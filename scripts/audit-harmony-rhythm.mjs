import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import abcjs from 'abcjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const baseline = option('--baseline');
if (!baseline) throw new Error('Provide --baseline path/to/runnable-arrange-snapshot.ts');
const manifestPath = path.resolve(root, option('--manifest', 'evidence/phase7/four-aligned-vocal-songs.json'));
const reportPath = path.resolve(root, option('--output', 'evidence/phase10/harmony-rhythm.json'));
const artifacts = path.resolve(root, option('--artifacts', 'data/phase10/arrangements'));
await mkdir(artifacts, { recursive: true });
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tuple = (n) => [n.midi, +n.start.toFixed(6), +n.duration.toFixed(6)];
const pitched = (part) => part.notes.filter((n) => n.midi !== null);
const fingerprint = (part) => pitched(part).map(tuple).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const stats = (part, tempo) => ({ events: pitched(part).length, under200ms: pitched(part).filter((n) => n.duration * 60 / tempo < .2 - 1e-8).length,
  atMost32nd: pitched(part).filter((n) => n.duration <= .125 + 1e-8).length });
const report = { scope: 'Before/after arranger rhythm on the same saved sources. Melody and harmony records remain unchanged. No transcription-accuracy or subjective singing claim.',
  baselineSha256: hash(await readFile(path.resolve(root, baseline))), currentSha256: hash(await readFile(path.join(root, 'src/lib/arrange.ts'))), cases: [] };
try {
  const old = await server.ssrLoadModule(path.resolve(root, baseline));
  const current = await server.ssrLoadModule('/src/lib/arrange.ts');
  const { toAbc, toMusicXml, fromMusicXml, validateProject } = await server.ssrLoadModule('/src/lib/music.ts');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const entry of manifest.results) {
    const bytes = await readFile(entry.projectPath);
    const source = JSON.parse(bytes);
    const snapshot = JSON.stringify(source);
    for (const preset of ['satb', 'ssaa', 'ttbb']) for (const style of ['pop', 'choral']) {
      const options = { preset, style, difficulty: 'medium', percussion: true, transpose: 0, leadPartId: 'vocals' };
      const before = old.arrangeForVoices(source, options);
      const after = current.arrangeForVoices(source, options);
      assert.deepEqual(validateProject(after), []);
      assert.deepEqual(fingerprint(after.parts[0]), fingerprint(before.parts[0]), 'Lead changed while fixing accompaniment');
      assert.deepEqual(after.chords, before.chords);
      assert.deepEqual(after.originalAudio, source.originalAudio);
      for (const part of after.parts.slice(1, 4)) {
        for (const n of pitched(part)) {
          assert.ok(n.midi >= part.range[0] && n.midi <= part.range[1]);
          const covered = after.chords.reduce((sum, chord) => sum + Math.max(0, Math.min(n.start + n.duration, chord.start + chord.duration) - Math.max(n.start, chord.start)), 0);
          assert.ok(Math.abs(covered - n.duration) < 1e-7, 'A voice filled a no-chord gap');
        }
      }
      for (let i = 1; i < 4; i++) for (const upper of pitched(after.parts[i - 1])) for (const lower of pitched(after.parts[i]))
        if (upper.start < lower.start + lower.duration - 1e-7 && lower.start < upper.start + upper.duration - 1e-7)
          assert.ok(upper.midi >= lower.midi, 'A new voice crossing was introduced');
      for (const plan of after.arrangement.report.breathing) {
        const part = after.parts.find((p) => p.id === plan.partId);
        if (part.role !== 'lead') {
          assert.equal(plan.phrasesOverTarget, 0, `${entry.filename} ${preset}/${style} ${part.id}: unresolved backing phrase`);
          // Compute independently from the sounding intervals, not just the planner report.
          let start = null, end = null, longest = 0;
          for (const n of pitched(part).filter((n) => n.velocity > 0).sort((a, b) => a.start - b.start)) {
            if (end === null || (n.start - end) * 60 / after.tempo >= .3 - 1e-7) start = n.start;
            end = Math.max(end ?? 0, n.start + n.duration);
            longest = Math.max(longest, (end - start) * 60 / after.tempo);
          }
          assert.ok(longest <= plan.targetSeconds + 1e-7, `Backing phrase lasts ${longest}s`);
          assert.ok(Math.abs(longest - plan.longestPhraseSeconds) < 1e-7);
        }
        for (const gap of plan.plannedGaps) {
          assert.ok((gap.resumeBeat - gap.startBeat) * 60 / after.tempo >= .3 - 1e-7);
          assert.ok(!pitched(part).some((n) => n.start < gap.resumeBeat - 1e-7 && n.start + n.duration > gap.startBeat + 1e-7));
        }
      }
      const xml = toMusicXml(after);
      const restored = fromMusicXml(xml);
      assert.deepEqual(restored.parts.map(fingerprint), after.parts.map(fingerprint));
      const engraving = toAbc(after);
      const tune = abcjs.parseOnly(engraving.abc)[0];
      const tracks = tune.setUpAudio({ chordsOff: true }).tracks;
      const trackParts = engraving.staffMap.flatMap((staff) => staff.voiceIds.map(() => staff.partId));
      assert.equal(tracks.length, trackParts.length);
      for (let i = 0; i < after.parts.length; i++) {
        const decoded = tracks.flatMap((track, index) => trackParts[index] === after.parts[i].id ? track : []).filter((n) => n.cmd === 'note').map((n) => [n.pitch, +(n.start * 4).toFixed(6), +(n.duration * 4).toFixed(6)])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(decoded, fingerprint(after.parts[i]));
      }
      const prefix = `${entry.jobId}-${preset}-${style}`;
      await writeFile(path.join(artifacts, prefix + '.json'), JSON.stringify(after));
      await writeFile(path.join(artifacts, prefix + '.musicxml'), xml);
      report.cases.push({ song: entry.filename, sourceJob: entry.jobId, preset, style, leadUnchanged: true, chordRecordsUnchanged: true,
        noCrossingsOrRangeViolations: true, realBreathGapsPreserved: true, backingPhraseDurationsChecked: true, noChordGapsPreserved: true, exactAbcAndXmlNotes: true,
        backingBreathing: after.arrangement.report.breathing.slice(1),
        voices: after.parts.slice(1, 4).map((part, i) => ({ partId: part.id, before: stats(before.parts[i + 1], before.tempo), after: stats(part, after.tempo),
          remainingShortExamples: pitched(part).filter((n) => n.duration * 60 / after.tempo < .2 - 1e-8).slice(0, 5).map(tuple) })) });
      assert.equal(JSON.stringify(source), snapshot);
    }
    assert.equal(hash(await readFile(entry.projectPath)), hash(bytes));
  }
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ cases: report.cases.length, allStructuralChecksPassed: true }));
  for (const row of report.cases.filter((x) => x.preset === 'satb' && x.style === 'pop')) console.log(JSON.stringify(row));
} finally { await server.close(); }
