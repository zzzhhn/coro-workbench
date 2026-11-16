import type { ChordEvent, NoteEvent, ScoreProject } from './types';
import { beatsPerBar, validateProject } from './music';
import type { SourceHarmony } from './sourceHarmony';

const IDS = ['voice-s', 'voice-a', 'voice-t', 'voice-b'];
const RANGES = [[62, 76], [55, 69], [48, 64], [40, 55]];
const pc = (n: number) => ((n % 12) + 12) % 12;
const EPS = 1e-6;
const overlaps = (a: number, b: number, c: number, d: number) => a < d - EPS && b > c + EPS;
const sounding = (n: NoteEvent, t: number) => n.midi !== null && n.start <= t + EPS && n.start + n.duration > t + EPS;
interface Piece { note: NoteEvent; original: number; start: number; end: number }
interface State { cost: number; current: Array<number | null>; last: Array<number | null>; path: Array<Array<number | null>> }

function bassClass(chord: ChordEvent) {
  const slash = chord.symbol.split('/')[1]?.match(/^([A-G])([b#]?)/);
  if (slash) return pc(({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[slash[1]] ?? 0) + (slash[2] === '#' ? 1 : slash[2] === 'b' ? -1 : 0));
  return pc(chord.pitches[0]);
}

/** Joint, bounded beam search over the sounding SATB ensemble. The supplied
 * harmonic hypotheses and rhythmic gestures remain separate from realization.
 * Notes may change pitch at an actual chord boundary; unchanged common tones
 * are rejoined to avoid manufacturing repeated syllables. No song-specific rules. */
export function realizeJointVoicing(source: ScoreProject, span: { first: number; last: number }, sourceHarmony?: SourceHarmony[], options: {
  sourceStructure?: boolean;
  tessitura?: Array<[number, number]>;
} = {}) {
  const bar = beatsPerBar(source), start = (span.first - 1) * bar, end = span.last * bar;
  if (!(start >= 0 && end > start && end <= source.measures * bar)) throw Error('Invalid voicing span');
  const parts = IDS.map(id => source.parts.find(p => p.id === id));
  if (parts.some(p => !p) || !source.parts.some(p => p.id === 'solo')) throw Error('Joint audition requires Solo + SATB');
  const lead = source.parts.find(p => p.id === 'solo')!.notes.filter(n => n.midi !== null && overlaps(start, end, n.start, n.start + n.duration));
  const harmony = sourceHarmony?.filter(c => overlaps(start, end, c.start, c.start + c.duration));
  const chords = (harmony ? harmony.map(c => ({ start: c.start, duration: c.duration, symbol: '', pitches: [c.bass, ...c.pitches.filter(p => p !== c.bass)] })) : source.chords)
    .filter(c => c.pitches.length && overlaps(start, end, c.start, c.start + c.duration));
  const chordAt = (t: number) => chords.find(c => c.start <= t + EPS && c.start + c.duration > t + EPS);
  // An evidence gap is not a new chord: do not reset a held singer to its old
  // target just because the upstream harmonic annotation ended.
  const boundaries = [...new Set(chords.map(c => c.start))].filter(t => t > start && t < end);
  const pieces = parts.map(part => part!.notes.flatMap((note, original): Piece[] => {
    if (note.midi === null || !overlaps(start, end, note.start, note.start + note.duration)) return [];
    const a = Math.max(start, note.start), b = Math.min(end, note.start + note.duration);
    const cuts = [a, ...boundaries.filter(t => t > a + EPS && t < b - EPS), b].sort((x, y) => x - y);
    return cuts.slice(0, -1).map((t, i) => ({ note, original, start: t, end: cuts[i + 1] }));
  }));
  for (const voice of pieces) for (let i = 1; i < voice.length; i++)
    if (voice[i].start < voice[i - 1].end - EPS) throw Error('Joint audition requires monophonic background voices');
  const times = [...new Set([start, end, ...boundaries, ...chords.map(c => c.start + c.duration).filter(t => t > start && t < end), ...pieces.flat().flatMap(n => [n.start, n.end]),
    ...lead.flatMap(n => [Math.max(start, n.start), Math.min(end, n.start + n.duration)])])].sort((a, b) => a - b);
  const frames = times.slice(0, -1).map((t, i) => ({ start: t, duration: times[i + 1] - t,
    notes: pieces.map(ns => ns.find(n => n.start <= t + EPS && n.end > t + EPS)),
    chord: chordAt(t), solo: lead.filter(n => sounding(n, t)) }));
  const initial = parts.map(p => p!.notes.filter(n => n.midi !== null && n.start < start).at(-1)?.midi ?? null);
  let beam: State[] = [{ cost: 0, current: [null, null, null, null], last: initial, path: [] }];
  frames.forEach((frame, frameIndex) => {
    const { chord, notes, solo, duration, start: t } = frame;
    const chordPcs = new Set(chord?.pitches.map(pc) ?? []);
    const newNote = notes.map((n, v) => !!n && (frameIndex === 0 || frames[frameIndex - 1].notes[v] !== n));
    const targets = notes.map(n => n?.note.midi ?? null);
    const choices = notes.map((n, v): Array<number | null> => {
      if (!n) return [null];
      if (!chord) return [n.note.midi];
      // Preserve an existing short stepwise connection only when both adjacent
      // pitches explain its preparation/resolution. Never invent a chromatic fill.
      const siblings = parts[v]!.notes, before = siblings[n.original - 1], after = siblings[n.original + 1];
      const weak = n.note.start % 1 !== 0 || (v === 3 && Math.abs(n.note.start % bar - (bar - 1)) < EPS);
      const minor = /^[A-G][b#]?m(?!aj)/.test(chord.symbol);
      const scale = (minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map(n => pc(n + chord.pitches[0]));
      const passing = !harmony && n.note.duration <= (v === 3 ? 1 : 0.5) && weak && before?.midi != null && after?.midi != null
        && Math.abs(n.note.midi! - before.midi) <= 2 && Math.abs(after.midi - n.note.midi!) <= 2
        && chordPcs.has(pc(after.midi)) && scale.includes(pc(n.note.midi!));
      let pitches = Array.from({ length: RANGES[v][1] - RANGES[v][0] + 1 }, (_, k) => k + RANGES[v][0])
        .filter(p => chordPcs.has(pc(p)) || (passing && p === n.note.midi));
      if (v === 3) {
        // Root/inversion is an arrival requirement, not a small optional bonus
        // that a target inherited from a wrong chord can outweigh.
        const bass = bassClass(chord);
        pitches = pitches.filter(p => pc(p) === bass || (passing && p === n.note.midi));
      }
      return pitches.sort((a, b) => Math.abs(a - n.note.midi!) - Math.abs(b - n.note.midi!));
    });
    const next: State[] = [];
    for (const previous of beam) {
      const current: Array<number | null> = [null, null, null, null];
      const visit = (v: number, pitchCost: number) => {
        if (v < 4) {
          const candidates = !newNote[v] && notes[v] ? [previous.current[v]] : choices[v];
          for (const pitch of candidates) {
            // Higher numbered voices must stay below already assigned singers.
            if (pitch !== null && current.slice(0, v).some(p => p !== null && p <= pitch)) continue;
            current[v] = pitch;
            let cost = pitchCost;
            if (pitch !== null && newNote[v]) {
              const target = targets[v]!;
              cost += Math.abs(pitch - target) * 1.4;
              const last = previous.last[v];
              if (last !== null) {
                const step = pitch - last;
                cost += Math.abs(step) * 0.45 + Math.max(0, Math.abs(step) - (v === 3 ? 7 : 5)) ** 2 * 2;
                const index = notes[v]!.original, prior = parts[v]!.notes[index - 1];
                if (prior?.midi != null && notes[v]!.start === notes[v]!.note.start) {
                  const desired = target - prior.midi;
                  cost += Math.abs(step - desired) * (solo.length ? 1.2 : 1.8);
                  if (desired && step === 0) cost += 1.5;
                }
              }
            }
            visit(v + 1, cost);
          }
          return;
        }
        let vertical = 0;
        const active = current.filter((p): p is number => p !== null), pcs = new Set(active.map(pc));
        if (options.tessitura) current.forEach((pitch, v) => {
          if (pitch !== null) {
            const band = options.tessitura![v];
            if (band) vertical += Math.max(0, band[0] - pitch, pitch - band[1]) ** 2;
          }
        });
        for (let i = 0; i < 4; i++) if (current[i] !== null) {
          for (let j = i + 1; j < 4; j++) if (current[j] !== null) {
            const distance = current[i]! - current[j]!, interval = pc(distance);
            if (distance <= 2) vertical += distance === 1 ? 18 : 8;
            // Wide sevenths/ninths can be intentional colors, low close seconds
            // and exposed semitone clusters are not equivalent to those colors.
            if ((interval === 1 || interval === 11) && !(chordPcs.has(pc(current[i]!)) && chordPcs.has(pc(current[j]!)))) vertical += 5;
            if (j === 3 && distance < 7) vertical += (7 - distance) * 2;
            if (j === i + 1 && j < 3 && distance > 12) vertical += (distance - 12) * 0.7;
          }
          for (const n of solo) {
            const distance = Math.abs(current[i]! - n.midi!);
            if (distance === 1) vertical += 10;
            else if (pc(distance) === 1 || pc(distance) === 11) vertical += 1.2;
          }
        }
        if (chord && active.length >= 3) {
          if (options.sourceStructure && harmony) {
            const bass = bassClass(chord);
            const upper = new Set(current.slice(0, 3).filter((p): p is number => p !== null).map(pc));
            // Preserve supported upper harmony before doubling an existing tone.
            // No chord member is fabricated: every candidate is still in source.
            vertical += Math.max(0, Math.min(3, chordPcs.size - 1) - upper.size) * 12;
            if (chordPcs.size >= 4 && upper.has(bass)) vertical += 8;
            for (const member of chordPcs) {
              if ([3, 4, 10, 11].includes(pc(member - bass)) && !pcs.has(member)) vertical += 8;
            }
            // Prefer a supported coherent upper triad to an arbitrary subset of
            // extensions; allow augmented/diminished structures actually present.
            const shapes = [[0, 4, 7], [0, 3, 7], [0, 3, 6], [0, 4, 8]];
            if (upper.size === 3 && [...upper].some(root => shapes.some(shape => shape.every(d => upper.has(pc(root + d)))))) vertical -= 5;
          }
          // Solo silence increases responsibility for harmonic identity. With
          // four singers, prioritize third/seventh before optional color tones.
          const root = pc(chord.pitches[0]), third = chord.pitches.map(pc).find(p => [3, 4, 5].includes(pc(p - root)));
          const seventh = chord.pitches.map(pc).find(p => [10, 11].includes(pc(p - root)));
          // A voiced source need not contain the named root's third or seventh.
          // Its actual palette constrains pitches; do not complete a chord name.
          if (!harmony && third !== undefined && !pcs.has(third)) vertical += solo.length ? 5 : 11;
          if (!harmony && seventh !== undefined && !pcs.has(seventh)) vertical += solo.length ? 0.5 : 2;
          // Doubling a root/fifth is legitimate. Demanding four different pitch
          // classes at every instant flattens melodic gestures into chord filling.
          vertical += Math.max(0, Math.min(3, active.length, chordPcs.size) - pcs.size) * (solo.length ? 2 : 4);
        }
        // Limit repeated parallel perfect intervals without prohibiting useful
        // stylistic parallels or sacrificing a phrase's melodic contour.
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
          if (!newNote[i] || !newNote[j] || current[i] === null || current[j] === null || previous.last[i] === null || previous.last[j] === null) continue;
          const before = pc(previous.last[i]! - previous.last[j]!), after = pc(current[i]! - current[j]!);
          if ([0, 7].includes(before) && before === after && Math.sign(current[i]! - previous.last[i]!) === Math.sign(current[j]! - previous.last[j]!) && current[i] !== previous.last[i]) pitchCost += 2;
        }
        next.push({ cost: previous.cost + pitchCost + vertical * duration, current: [...current],
          last: current.map((p, v) => p ?? previous.last[v]), path: [...previous.path, [...current]] });
      };
      visit(0, 0);
    }
    if (!next.length) throw Error(`No joint voicing at beat ${t}`);
    // Current pitches plus last sung pitches determine all future transition
    // costs. Deduplicate before pruning so one voicing cannot fill the beam.
    const seen = new Set<string>();
    beam = next.sort((a, b) => a.cost - b.cost).filter(s => {
      const key = s.current.join(',') + '/' + s.last.join(',');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 32);
  });
  const result = structuredClone(source), decisions: Array<{ voice: string; start: number; from: number; to: number; continuation: boolean }> = [];
  parts.forEach((part, v) => {
    const realized: Array<NoteEvent & { original: number }> = [];
    for (const piece of pieces[v]) {
      const frame = frames.findIndex(f => Math.abs(f.start - piece.start) < EPS);
      const pitch = beam[0].path[frame][v]!;
      const tail = realized.at(-1);
      if (tail && tail.original === piece.original && tail.midi === pitch && Math.abs(tail.start + tail.duration - piece.start) < EPS) tail.duration += piece.end - piece.start;
      else realized.push({ ...piece.note, original: piece.original,
        id: piece.start === piece.note.start ? piece.note.id : `${piece.note.id}-harmony-${piece.start}`,
        start: piece.start, duration: piece.end - piece.start, midi: pitch,
        ...(piece.start > piece.note.start ? { lyric: '', dynamic: undefined } : {}) });
      if (pitch !== piece.note.midi) decisions.push({ voice: IDS[v], start: piece.start, from: piece.note.midi!, to: pitch, continuation: piece.start > piece.note.start });
    }
    const outside = part!.notes.flatMap(n => !overlaps(start, end, n.start, n.start + n.duration) || n.midi === null ? [n] : [
      ...(n.start < start ? [{ ...n, duration: start - n.start }] : []),
      ...(n.start + n.duration > end ? [{ ...n, id: n.id + '-outside', start: end, duration: n.start + n.duration - end }] : []),
    ]);
    result.parts.find(p => p.id === IDS[v])!.notes = [...outside, ...realized.map(({ original, ...n }) => n)].sort((a, b) => a.start - b.start);
  });
  const errors = validateProject(result);
  if (errors.length) throw Error(errors.join('\n'));
  return { project: result, decisions, cost: beam[0].cost };
}
