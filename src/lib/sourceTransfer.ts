import type { NoteEvent, ScoreProject } from './types';
import { beatsPerBar } from './music';

const IDS = ['voice-s', 'voice-a', 'voice-t', 'voice-b'];
const RANGES = [[60, 79], [55, 74], [48, 69], [36, 60]];
const CENTRES = [70, 64, 57, 45];
const pc = (n: number) => (n % 12 + 12) % 12;
const EPS = 1e-6;
type Pitched = NoteEvent & { midi: number };
export interface TransferSlice {
  start: number; duration: number; sourceNoteIds: string[];
  sourcePitches: number[]; kept: number[]; omitted: number[]; voicing: number[];
}

/** Literal reduction of selected accompaniment staves, not harmonic inference.
 * No chord dictionary, Solo-based correction, invented tone, or pedal extension.
 * Rhythmic figures in the source remain rhythmic figures in the reduction. */
export function transferSourceToSatb(
  scaffold: ScoreProject, source: ScoreProject, accompanimentIds: string[],
  spans: Array<{ first: number; last: number }>,
  options: { collapseRolledChords?: boolean; reducePerformedGraceNotes?: boolean } = {},
) {
  const project = structuredClone(scaffold), bar = beatsPerBar(source);
  if (beatsPerBar(project) !== bar || !IDS.every(id => project.parts.some(p => p.id === id))) throw Error('SATB scaffold/meter mismatch');
  if (!accompanimentIds.length || accompanimentIds.some(id => !source.parts.some(p => p.id === id))) throw Error('Select source accompaniment staves');
  const rolls: Array<{ sourceNoteIds: string[]; start: number; end: number }> = [];
  const ornaments: Array<{ graceId: string; mainIds: string[]; start: number; end: number }> = [];
  const notes: Pitched[] = source.parts.filter(p => accompanimentIds.includes(p.id)).flatMap(part => {
    const ns = structuredClone(part.notes.filter((n): n is Pitched => n.midi !== null)).sort((a, b) => a.start - b.start || a.midi - b.midi);
    // MIDI may perform one written rolled chord as staggered attacks. This is
    // optional, narrowly bounded, and logged separately from literal allocation.
    if (options.collapseRolledChords) for (let i = 0; i < ns.length; i++) {
      const group = [ns[i]];
      for (let j = i + 1; j < ns.length; j++) {
        const prev = group.at(-1)!, n = ns[j];
        if (n.start <= prev.start + EPS || n.start - prev.start > .125 + EPS || n.start - group[0].start > .25 + EPS || n.midi <= prev.midi) break;
        group.push(n);
      }
      if (group.length < 3 || group.some(n => n.duration < .45)) continue;
      const ends = group.map(n => n.start + n.duration);
      if (Math.max(...ends) - Math.min(...ends) > .08) continue;
      const start = group[0].start, meanEnd = ends.reduce((a, b) => a + b) / ends.length;
      const rounded = Math.round(meanEnd * 4) / 4, end = Math.abs(rounded - meanEnd) < .04 ? rounded : meanEnd;
      if (end - group.at(-1)!.start < .45) continue;
      rolls.push({ sourceNoteIds: group.map(n => n.id), start, end });
      group.forEach(n => { n.start = start; n.duration = end - start; });
      i += group.length - 1;
    }
    const excluded = new Set<string>();
    // An isolated performed acciaccatura differs from a run of short notes.
    // This optional backing reduction moves the following sustained event onto
    // its beat; the source stays intact and every decision remains reviewable.
    if (options.reducePerformedGraceNotes) for (let i = 0; i + 1 < ns.length; i++) {
      const grace = ns[i], next = ns[i + 1];
      if (grace.duration >= .125 || Math.abs(grace.start - Math.round(grace.start * 2) / 2) > EPS
        || next.start - grace.start > .125 || next.start <= grace.start
        || Math.abs(next.start - grace.start - grace.duration) > .02
        || ns.some(n => n !== grace && Math.abs(n.start - grace.start) < EPS)) continue;
      const main = ns.filter(n => Math.abs(n.start - next.start) < EPS);
      if (main.some(n => n.duration < .45 || n.midi === grace.midi)) continue;
      const ends = main.map(n => n.start + n.duration);
      if (Math.max(...ends) - Math.min(...ends) > .02) continue;
      const end = Math.round(ends[0] * 4) / 4;
      if (Math.abs(end - ends[0]) > .06) continue;
      excluded.add(grace.id);
      ornaments.push({ graceId: grace.id, mainIds: main.map(n => n.id), start: grace.start, end });
      main.forEach(n => { n.start = grace.start; n.duration = end - grace.start; });
    }
    return ns.filter(n => !excluded.has(n.id));
  });
  const slices: TransferSlice[] = [];
  const sortedSpans = [...spans].sort((a, b) => a.first - b.first);
  if (sortedSpans.some((s, i) => !Number.isInteger(s.first) || !Number.isInteger(s.last) || s.first < 1 || s.last < s.first || s.last > Math.min(project.measures, source.measures) || (i > 0 && s.first <= sortedSpans[i - 1].last))) throw Error('Invalid or overlapping spans');
  for (const span of sortedSpans) {
    const a = (span.first - 1) * bar, b = span.last * bar;
    const relevant = notes.filter(n => n.start < b && n.start + n.duration > a);
    const boundaries = [...new Set([a, b, ...relevant.flatMap(n => [Math.max(a, n.start), Math.min(b, n.start + n.duration)])])].sort((x, y) => x - y);
    const output: NoteEvent[][] = IDS.map(() => []);
    let previous: number[] | undefined;
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const start = boundaries[i], end = boundaries[i + 1];
      if (end - start < EPS) continue;
      const active = relevant.filter(n => n.start <= start + EPS && n.start + n.duration >= end - EPS).sort((x, y) => x.midi - y.midi);
      if (!active.length) { previous = undefined; continue; }
      const pitches = [...new Set(active.map(n => pc(n.midi)))];
      // More than four pitch classes cannot fit four monophonic singers. Keep
      // the actual bass and uppermost source tones; expose every omitted class.
      const kept = [pc(active[0].midi)];
      for (const n of [...active].reverse()) if (!kept.includes(pc(n.midi)) && kept.length < 4) kept.push(pc(n.midi));
      const choices = RANGES.map(([lo, hi], v) => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)
        .filter(m => v === 3 ? pc(m) === pc(active[0].midi) : kept.includes(pc(m))));
      let best: number[] | undefined, cost = Infinity;
      for (const s of choices[0]) for (const alto of choices[1]) for (const t of choices[2]) for (const bass of choices[3]) {
        const v = [s, alto, t, bass];
        if (s < alto || alto < t || t < bass || s - alto > 12 || alto - t > 12 || !kept.every(p => v.some(n => pc(n) === p))) continue;
        const c = v.reduce((sum, n, voice) => sum + Math.abs(n - CENTRES[voice]) * .35 + (previous ? Math.abs(n - previous[voice]) : 0), 0)
          + (s === alto ? 2 : 0) + (alto === t ? 2 : 0);
        if (c < cost) { cost = c; best = v; }
      }
      if (!best) throw Error(`No source-faithful SATB allocation at beat ${start}`);
      slices.push({ start, duration: end - start, sourceNoteIds: active.map(n => n.id), sourcePitches: pitches, kept,
        omitted: pitches.filter(p => !kept.includes(p)), voicing: best });
      best.forEach((midi, v) => {
        const tail = output[v].at(-1);
        const reattack = active.some(n => Math.abs(n.start - start) < EPS && pc(n.midi) === pc(midi));
        if (tail && tail.midi === midi && Math.abs(tail.start + tail.duration - start) < EPS && !reattack) tail.duration += end - start;
        else output[v].push({ id: `transfer-${IDS[v]}-${start}`, midi, start, duration: end - start, velocity: .48,
          lyric: !tail || start - tail.start - tail.duration >= .5 - EPS ? 'Hmm' : '',
          ...(!tail ? { dynamic: 'p' as const } : {}), origin: 'arranged' });
      });
      previous = best;
    }
    IDS.forEach((id, v) => {
      const part = project.parts.find(p => p.id === id)!;
      const outside = part.notes.flatMap(n => n.start >= b || n.start + n.duration <= a ? [n] : [
        ...(n.start < a ? [{ ...n, duration: a - n.start }] : []),
        ...(n.start + n.duration > b ? [{ ...n, id: n.id + '-outside', start: b, duration: n.start + n.duration - b }] : []),
      ]);
      part.notes = [...outside, ...output[v]].sort((x, y) => x.start - y.start);
    });
  }
  return { project, slices, rolls, ornaments };
}
