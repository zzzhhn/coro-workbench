// Emit anonymous bar-level evidence for an independent whole-song planner.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function formBrief(source, leadPartId) {
  const bar = (source.timeSignature[0] * 4) / source.timeSignature[1];
  const q = (n) => Math.round(n * 1000) / 1000;
  if (!source.parts.some((p) => p.id === leadPartId)) throw Error('Unknown lead');
  const tracks = [...source.parts].sort((a, b) => Number(b.id === leadPartId) - Number(a.id === leadPartId));
  const bars = Array.from({ length: source.measures }, (_, index) => {
    const start = index * bar,
      end = start + bar;
    const material = tracks.map((p) =>
      p.notes
        .filter((n) => n.midi !== null && n.start < end && n.start + n.duration > start)
        .map((n) => [q(n.start - start), n.midi, q(n.duration)]),
    );
    const harmony = source.chords
      .filter((c) => c.start < end && c.start + c.duration > start)
      .map((c) => [q(c.start - start), c.pitches]);
    return { bar: index + 1, tracks: material, harmony };
  });
  const data = {
    tempo: source.tempo,
    meter: source.timeSignature,
    roles: tracks.map((p, i) => (i ? p.role : 'lead')),
    bars,
  };
  const inputSHA256 = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return { inputSHA256, ...data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, lead] = process.argv.slice(2);
  console.log(JSON.stringify(formBrief(JSON.parse(readFileSync(path, 'utf8')), lead)));
}
