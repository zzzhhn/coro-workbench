import type { ChordEvent, NoteEvent, ScoreProject } from './types';
import { beatsPerBar, validateProject } from './music';

/** Audition-only musical sketches, not a song-form detector or production default. */
export type SketchIntent = 'flow' | 'conversation' | 'lift';
export interface SketchSpan { first: number; last: number; intent: SketchIntent }
interface Gesture { start: number; end: number; chord: ChordEvent; kind: 'bed' | 'answer' | 'pulse'; contour: number; release: number; arch: number }
type Voicing = [number, number, number, number]; // S, A, T, B
const IDS = ['voice-s', 'voice-a', 'voice-t', 'voice-b'];
const RANGES = [[62, 76], [55, 69], [48, 64], [40, 55]];
const EPS = 1e-6;
const pc = (n: number) => ((n % 12) + 12) % 12;
const sounding = (n: NoteEvent, a: number, b: number) => n.midi !== null && n.start < b - EPS && n.start + n.duration > a + EPS;
const grid = (n: number) => Math.round(n * 2) / 2;

function root(chord: ChordEvent) {
  const match = chord.symbol.match(/(?:\/|^)([A-G])([#b]?)$/) ?? chord.symbol.match(/^([A-G])([#b]?)/);
  if (!match) return pc(chord.pitches[0]);
  return pc(({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1] as 'C']) + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0));
}

function phrases(notes: NoteEvent[], a: number, b: number) {
  const sorted = notes.filter(n => sounding(n, a, b)).sort((x, y) => x.start - y.start);
  const out: { start: number; end: number; notes: NoteEvent[] }[] = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && n.start - last.end < 0.75) { last.end = Math.max(last.end, n.start + n.duration); last.notes.push(n); }
    else out.push({ start: n.start, end: n.start + n.duration, notes: [n] });
  }
  return out;
}

/** Harmonic arrivals and phrase responses, not a per-voice attendance schedule. */
function gestures(project: ScoreProject, span: SketchSpan): Gesture[] {
  const bar = beatsPerBar(project), a = (span.first - 1) * bar, b = span.last * bar;
  const lead = project.parts.find(p => p.id === 'solo')!.notes;
  const lines = phrases(lead, a, b);
  const phraseGaps = lines.map((line, i) => ({ start: Math.ceil(line.end * 2) / 2,
    end: Math.floor(Math.min(lines[i + 1]?.start ?? b, b) * 2) / 2, line }))
    .filter(g => g.end - g.start >= 0.5);
  const gaps = phraseGaps.filter(g => g.end - g.start >= 1.5);
  const slots = project.chords.filter(c => c.start < b && c.start + c.duration > a && c.pitches.length);
  const out: Gesture[] = [];
  for (const chord of slots) {
    const from = Math.max(a, chord.start), to = Math.min(b, chord.start + chord.duration);
    const cuts = new Set([from, to]);
    const active = lead.filter(n => sounding(n, from, to));
    // Retain harmonic motion even when the singer has no gap. Density determines
    // whether there is room for an internal breath/arrival, not who is allowed to sing.
    if (span.intent === 'lift') {
      const accents = active.filter(n => n.duration >= 0.5).map(n => Math.round(n.start))
        .filter(t => t >= from + 1 && t <= to - 1);
      if (accents.length) cuts.add(accents[Math.floor(accents.length / 2)]);
    }
    for (const gap of gaps) {
      if (span.intent === 'flow' || gap.start >= to || gap.end <= from) continue;
      const start = Math.max(from, gap.start), end = Math.min(to, gap.end);
      cuts.add(start); cuts.add(end);
      // One-beat response syllables; leave half a beat before the next Solo entry.
      for (let t = start + 1; t <= end - 0.5; t += 1) cuts.add(t);
    }
    const times = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i < times.length - 1; i++) {
      const start = times[i], end = times[i + 1];
      if (end - start < 0.5 - EPS) continue;
      const gap = gaps.find(g => start >= g.start && start < g.end);
      if (gap && span.intent !== 'flow' && end === gap.end && end - start <= 0.5) continue;
      const tail = gap?.line.notes.filter(n => n.duration >= 0.5).slice(-3) ?? [];
      const direction = tail.length > 1 ? Math.sign(tail.at(-1)!.midi! - tail[0].midi!) : 0;
      const answer = !!gap && span.intent !== 'flow';
      const phrase = lines.find(p => p.start <= start && p.end > start) ?? gap?.line;
      const progress = phrase ? Math.min(1, Math.max(0, (start - phrase.start) / Math.max(1, phrase.end - phrase.start))) : 0;
      const cadenceGap = span.intent === 'flow' ? phraseGaps.find(g => g.start >= end - 1 && g.start < end && g.line.end - g.line.start >= 2) : undefined;
      out.push({ start, end, chord, kind: answer ? 'answer' : span.intent === 'lift' ? 'pulse' : 'bed',
        contour: answer ? -direction : 0,
        arch: Math.sin(progress * Math.PI),
        release: cadenceGap ? end - cadenceGap.start : end === b ? 0.5 : 0 });
    }
  }
  return out;
}

function options(g: Gesture): Voicing[] {
  const pcs = [...new Set(g.chord.pitches.map(pc))];
  const pitches = RANGES.map(([lo, hi], v) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
    .filter(n => v === 3 ? pc(n) === root(g.chord) : pcs.includes(pc(n))));
  const out: Voicing[] = [];
  for (const s of pitches[0]) for (const a of pitches[1]) for (const t of pitches[2]) for (const b of pitches[3]) {
    if (s <= a || a <= t || t <= b || s - a > 12 || a - t > 12 || t - b > 19) continue;
    if (new Set([s, a, t, b].map(pc)).size < Math.min(3, pcs.length)) continue;
    out.push([s, a, t, b]);
  }
  return out;
}

function localCost(v: Voicing, g: Gesture, lead: NoteEvent[], intent: SketchIntent) {
  const centers = intent === 'lift' ? [69 + g.arch * 4, 63 + g.arch * 2, 57, 46] : [66 + g.arch * 4, 60 + g.arch * 2, 55, 46];
  let cost = v.reduce((sum, n, i) => sum + Math.abs(n - centers[i]) * 0.2, 0);
  const pcs = [...new Set(g.chord.pitches.map(pc))];
  cost += pcs.filter(p => !v.some(n => pc(n) === p)).length * 3;
  const overlap = lead.filter(n => sounding(n, g.start, g.end));
  // Weight audible collision by overlap duration rather than every ornament onset.
  for (const n of overlap) {
    const duration = Math.min(g.end, n.start + n.duration) - Math.max(g.start, n.start);
    for (const pitch of v.slice(0, 3)) {
      const distance = Math.abs(pitch - n.midi!);
      if (distance === 1) cost += duration * 3;
      if (distance === 2) cost += duration * 0.7;
    }
  }
  return cost;
}

function transition(old: Voicing, next: Voicing, g: Gesture) {
  let cost = 0;
  for (let i = 0; i < 4; i++) {
    const jump = Math.abs(next[i] - old[i]);
    cost += jump * (i === 3 ? 0.5 : 0.7) + Math.max(0, jump - 4) ** 2 * 1.5;
    if (g.kind === 'answer' && i === 0) {
      if (!jump) cost += 5;
      if (g.contour && Math.sign(next[i] - old[i]) !== g.contour) cost += 3;
    }
  }
  // Exposed parallel perfect intervals are a soft musical warning, not a universal ban.
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 4; j++) {
    if ([0, 7].includes(pc(old[i] - old[j])) && pc(old[i] - old[j]) === pc(next[i] - next[j]) &&
      Math.sign(next[i] - old[i]) === Math.sign(next[j] - old[j]) && next[i] !== old[i]) cost += 2;
  }
  return cost;
}

function voiceLead(events: Gesture[], lead: NoteEvent[], intent: SketchIntent): Voicing[] {
  let beam: { cost: number; path: Voicing[] }[] = [{ cost: 0, path: [] }];
  for (const g of events) {
    const candidates = options(g).map(v => ({ v, local: localCost(v, g, lead, intent) }));
    if (!candidates.length) throw Error(`No singable voicing at beat ${g.start}`);
    const next = candidates.map(({ v, local }) => {
      let best = beam[0], cost = Infinity;
      for (const prior of beam) {
        const c = prior.cost + local + (prior.path.length ? transition(prior.path.at(-1)!, v, g) : 0);
        if (c < cost) { best = prior; cost = c; }
      }
      return { cost, path: [...best.path, v] };
    });
    beam = next.sort((a, b) => a.cost - b.cost).slice(0, 48);
  }
  return beam[0].path;
}

export function createEnsembleSketch(source: ScoreProject, span: SketchSpan) {
  const bar = beatsPerBar(source), start = (span.first - 1) * bar, end = span.last * bar;
  if (!Number.isInteger(span.first) || !Number.isInteger(span.last) || span.first < 1 || span.last < span.first || span.last > source.measures)
    throw Error('Invalid sketch span');
  if (!source.parts.some(p => p.id === 'solo') || IDS.some(id => !source.parts.some(p => p.id === id)) || source.parts.length !== 5)
    throw Error('Sketch requires an existing Solo + SATB project');
  const result = structuredClone(source);
  const events = gestures(source, span);
  if (!events.length) throw Error('Sketch requires harmonic evidence in the selected span');
  const lead = source.parts.find(p => p.id === 'solo')!.notes;
  const voicings = voiceLead(events, lead, span.intent);
  const trace = events.map((g, i) => ({ ...g, pitches: voicings[i] }));
  IDS.forEach((id, voice) => {
    const part = result.parts.find(p => p.id === id)!;
    // This is a bounded rewrite: retain both tails of any source note crossing a boundary.
    const outside = part.notes.flatMap(n => {
      if (n.start >= end || n.start + n.duration <= start) return [n];
      const pieces: NoteEvent[] = [];
      if (n.start < start) pieces.push({ ...n, duration: start - n.start });
      if (n.start + n.duration > end) pieces.push({ ...n, id: n.id + '-tail', start: end, duration: n.start + n.duration - end });
      return pieces;
    });
    const notes: NoteEvent[] = [];
    events.forEach((g, i) => {
      const pitch = voicings[i][voice];
      const release = g.end - g.start >= g.release + 0.5 ? g.release : 0;
      const duration = grid(g.end - g.start - release);
      if (duration < 0.5) return;
      const last = notes.at(-1);
      // Sustain common tones in a shared bed; articulate responses and pulses.
      const sustain = g.kind === 'bed' || voice === 3;
      if (sustain && last?.midi === pitch && Math.abs(last.start + last.duration - g.start) < EPS &&
        last.duration + duration <= 6) { last.duration += duration; return; }
      notes.push({ id: `sketch-${span.first}-${voice}-${i}`, midi: pitch, start: g.start, duration,
        velocity: voice === 3 ? 0.62 : g.kind === 'answer' ? 0.64 : span.intent === 'lift' ? 0.61 : 0.5,
        lyric: voice === 3 ? 'Dm' : g.kind === 'answer' ? 'doo' : g.kind === 'pulse' ? 'Doo' : 'Ooh',
        origin: 'arranged', ...(i === 0 ? { dynamic: span.intent === 'lift' ? 'mf' as const : 'mp' as const } : {}) });
    });
    part.notes = [...outside, ...notes].sort((a, b) => a.start - b.start);
  });
  const errors = validateProject(result);
  if (errors.length) throw Error(errors.join('\n'));
  return { project: result, trace };
}
