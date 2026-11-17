import type { ChordEvent, ScoreProject } from './types';
import { beatsPerBar } from './music';

const pc = (n: number) => ((n % 12) + 12) % 12;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const QUALITIES = [
  { suffix: '', intervals: [0, 4, 7] }, { suffix: 'm', intervals: [0, 3, 7] },
  { suffix: '7', intervals: [0, 4, 7, 10] }, { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] }, { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
  { suffix: '6', intervals: [0, 4, 7, 9] }, { suffix: 'm6', intervals: [0, 3, 7, 9] },
  { suffix: 'add9', intervals: [0, 4, 7, 2] }, { suffix: 'm(add9)', intervals: [0, 3, 7, 2] },
  { suffix: '9', intervals: [0, 4, 7, 10, 2] }, { suffix: 'maj9', intervals: [0, 4, 7, 11, 2] },
  { suffix: 'm9', intervals: [0, 3, 7, 10, 2] }, { suffix: '7sus4', intervals: [0, 5, 7, 10] },
];
const CHORDS = QUALITIES.flatMap(q => Array.from({ length: 12 }, (_, root) => ({
  root, symbol: NAMES[root] + q.suffix, pcs: q.intervals.map(i => pc(root + i)),
})));
export interface HarmonyFrame {
  start: number;
  duration: number;
  evidence: Array<{ midiClass: number; weight: number }>;
  bass: number | null;
  selected: string;
  alternatives: Array<{ symbol: string; cost: number }>;
  review: string[];
}

/** Accompaniment-only harmonic hypotheses. Costs are not calibrated confidence.
 * Lead ornaments never become evidence for accompaniment chord identity.
 * Quarter-note frames allow within-bar changes; sequence decoding suppresses
 * unsupported changes, but never bridges a silent gap as if it were evidence. */
export function analyzeHarmonyEvidence(source: ScoreProject, leadPartId: string) {
  if (!source.parts.some(p => p.id === leadPartId)) throw Error('Unknown Solo part');
  const parts = source.parts.filter(p => p.id !== leadPartId && p.role !== 'percussion');
  if (!parts.some(p => p.notes.some(n => n.midi !== null))) throw Error('Harmony analysis requires accompaniment');
  const total = source.measures * beatsPerBar(source);
  const frames: Array<HarmonyFrame & { costs: number[] }> = [];
  for (let start = 0; start < total; start += 1) {
    const end = Math.min(total, start + 1), duration = end - start;
    const active = parts.map(p => p.notes.filter(n => n.midi !== null && n.start < end && n.start + n.duration > start));
    const weights = Array<number>(12).fill(0), bassWeights = Array<number>(12).fill(0);
    // Integrate actual sounding slices: repeated attacks and octave doublings
    // within one part cannot dominate merely by increasing note count.
    const cuts = [...new Set([start, end, ...active.flat().flatMap(n => [Math.max(start, n.start), Math.min(end, n.start + n.duration)])])].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const t = (cuts[i] + cuts[i + 1]) / 2, d = (cuts[i + 1] - cuts[i]) / duration;
      const sounding = active.map(ns => ns.filter(n => n.start <= t && n.start + n.duration > t));
      for (const ns of sounding) for (const pitch of new Set(ns.map(n => pc(n.midi!)))) weights[pitch] += d;
      const notes = sounding.flat();
      if (notes.length) bassWeights[pc(Math.min(...notes.map(n => n.midi!)))] += d;
    }
    const mass = weights.reduce((s, v) => s + v, 0);
    const bass = Math.max(...bassWeights) >= 0.5 ? bassWeights.indexOf(Math.max(...bassWeights)) : null;
    const evidence = weights.flatMap((weight, midiClass) => weight > 1e-6 ? [{ midiClass, weight }] : []);
    const costs = CHORDS.map(c => {
      if (!mass) return 0;
      const outside = weights.reduce((s, w, i) => s + (c.pcs.includes(i) ? 0 : w), 0) / mass;
      const missing = c.pcs.reduce((s, pitch, i) => s + Math.max(0, 0.3 - weights[pitch]) * (i === 3 ? 1.2 : 2), 0);
      const bassCost = bass === null ? 0 : c.root === bass ? 0 : c.pcs.includes(bass) ? 0.32 : 1.4;
      return outside * 5 + missing + bassCost + (c.pcs.length === 4 ? 0.08 : 0);
    });
    frames.push({ start, duration, evidence, bass, selected: '', alternatives: [], review: [], costs });
  }
  const chosen = Array<number>(frames.length).fill(-1);
  // Segmental decoding pools arpeggio evidence before scoring a chord. Framewise
  // decoding mistakes each arpeggio member for a new harmonic identity.
  const bar = beatsPerBar(source);
  const segments: Array<{ from: number; end: number; chord: number; bass: number | null }> = [];
  for (let from = 0; from < frames.length;) {
    if (!frames[from].evidence.length) { from++; continue; }
    let end = from + 1;
    while (end < frames.length && frames[end].evidence.length) end++;
    const dp = Array.from({ length: end - from + 1 }, () => ({ cost: Infinity, previous: -1, chord: -1, bass: null as number | null }));
    dp[0].cost = 0;
    for (let stop = from + 1; stop <= end; stop++) {
      for (let begin = Math.max(from, stop - Math.ceil(bar * 2)); begin < stop; begin++) {
        const length = stop - begin;
        // Interior segments need at least two quarter beats. One-beat fragments
        // are allowed only next to an actual silence, never as every-beat churn.
        if (length < 2 && begin !== from && stop !== end) continue;
        if (!Number.isFinite(dp[begin - from].cost)) continue;
        const weights = Array<number>(12).fill(0);
        for (let j = begin; j < stop; j++) for (const e of frames[j].evidence) weights[e.midiClass] += e.weight / length;
        const mass = weights.reduce((s, v) => s + v, 0);
        const bass = frames[begin].bass;
        CHORDS.forEach((c, k) => {
          const outside = weights.reduce((s, w, i) => s + (c.pcs.includes(i) ? 0 : w), 0) / mass;
          const missing = c.pcs.reduce((s, pitch, i) => s + Math.max(0, 0.22 - weights[pitch]) * (i === 2 ? 0.5 : i > 2 ? 2 : 2.5), 0);
          const bassCost = bass === null ? 0 : c.root === bass ? 0 : c.pcs.includes(bass) ? 0.28 : 1;
          const prior = dp[begin - from];
          const change = prior.chord === k ? 0 : 1;
          const metric = begin % bar === 0 || begin % (bar / 2) === 0 ? 0 : 0.4;
          const cost = prior.cost + length * (outside * 5 + missing + bassCost + Math.max(0, c.pcs.length - 3) * 0.06) + change + metric;
          if (cost < dp[stop - from].cost) dp[stop - from] = { cost, previous: begin, chord: k, bass };
        });
      }
    }
    for (let stop = end; stop > from;) {
      const state = dp[stop - from];
      segments.push({ from: state.previous, end: stop, chord: state.chord, bass: state.bass });
      for (let i = state.previous; i < stop; i++) chosen[i] = state.chord;
      stop = state.previous;
    }
    from = end;
  }
  const chords: ChordEvent[] = [];
  frames.forEach((f, i) => {
    const k = chosen[i];
    if (k < 0) { f.selected = 'N.C.'; f.review.push('伴奏无证据'); return; }
    const c = CHORDS[k];
    const bass = segments.find(s => s.from <= i && s.end > i)!.bass;
    // Inversion follows a harmonic segment's arrival, not every passing bass note.
    f.selected = c.symbol + (bass !== null && bass !== c.root && c.pcs.includes(bass) ? '/' + NAMES[bass] : '');
    const ranked = f.costs.map((cost, j) => ({ symbol: CHORDS[j].symbol, cost, j })).sort((a, b) => a.cost - b.cost);
    f.alternatives = ranked.slice(0, 3).map(({ symbol, cost }) => ({ symbol, cost: Math.round(cost * 1000) / 1000 }));
    if (ranked[1].cost - ranked[0].cost < 0.25) f.review.push('多个和声解释接近');
    if (ranked[0].j !== k) f.review.push('由前后文选择');
    if (f.evidence.length < 3) f.review.push('和声音不足');
    const last = chords.at(-1);
    if (last && last.symbol === f.selected && Math.abs(last.start + last.duration - f.start) < 1e-6) last.duration += f.duration;
    else chords.push({ start: f.start, duration: f.duration, symbol: f.selected, pitches: c.pcs.map(p => 48 + p) });
  });
  return { chords, frames: frames.map(({ costs, ...frame }) => frame), sourcePartIds: parts.map(p => p.id) };
}
