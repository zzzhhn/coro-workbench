import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
const output = { scope: 'Chord semantic round trips, no-chord gaps and vocal ranges; not human song accuracy.', results: [] };
try {
  const { arrangeForVoices } = await server.ssrLoadModule('/src/lib/arrange.ts');
  const { toMusicXml, fromMusicXml, validateProject } = await server.ssrLoadModule('/src/lib/music.ts');
  const manifest = JSON.parse(await readFile(path.join(root, 'evidence/phase5/four-audio-harmony-songs.json'), 'utf8'));
  const signature = (project) => project.chords.map(chord => [chord.start, chord.duration, chord.symbol, [...new Set(chord.pitches.map(pitch => pitch % 12))].sort((a,b) => a-b)]);
  for (const entry of manifest.results) {
    const project = JSON.parse(await readFile(entry.projectPath, 'utf8'));
    const original = JSON.stringify(project);
    const variants = [{ name: 'source', project }];
    for (const preset of ['satb', 'ssaa', 'ttbb'])
      for (const style of ['pop', 'choral'])
        variants.push({ name: `${preset}-${style}`, project: arrangeForVoices(project, { preset, style, difficulty: 'medium', percussion: true, transpose: 0 }) });
    const rows = [];
    const dir = path.join(root, 'data/phase5/audio-harmony-exports', entry.jobId);
    await mkdir(dir, { recursive: true });
    for (const variant of variants) {
      assert.deepEqual(validateProject(variant.project), []);
      const xml = toMusicXml(variant.project);
      const restored = fromMusicXml(xml);
      assert.deepEqual(signature(restored), signature(variant.project), `${entry.filename} ${variant.name}`);
      if (variant.name !== 'source') {
        for (const part of variant.project.parts.slice(1).filter(part => part.role !== 'percussion'))
          for (const note of part.notes.filter(note => note.midi !== null)) {
            const covered = variant.project.chords.reduce((sum, chord) => sum + Math.max(0, Math.min(note.start + note.duration, chord.start + chord.duration) - Math.max(note.start, chord.start)), 0);
            assert.ok(Math.abs(covered - note.duration) < 1e-7, 'A harmony note crossed a no-chord gap');
            assert.ok(note.midi >= part.range[0] && note.midi <= part.range[1]);
          }
      }
      await writeFile(path.join(dir, `${variant.name}.musicxml`), xml);
      await writeFile(path.join(dir, `${variant.name}.json`), JSON.stringify(variant.project));
      rows.push({ variant: variant.name, chords: variant.project.chords.length, noChordMarkers: (xml.match(/>none<\/kind>/g) ?? []).length, symbolPitchClassesAndTimesExact: true, harmonyRespectsNoChordAndRanges: true });
    }
    assert.equal(JSON.stringify(project), original);
    output.results.push({ song: entry.filename, job: entry.jobId, rows });
  }
  await writeFile(path.join(root, 'evidence/phase5/audio-harmony-interchange.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ songs: output.results.length, variants: output.results.reduce((sum,row) => sum + row.rows.length,0), passed: true }));
} finally { await server.close(); }
