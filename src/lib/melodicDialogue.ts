import type { ChordEvent, NoteEvent, ScoreProject } from './types';
import { beatsPerBar, validateProject } from './music';
import { createEnsembleSketch, type SketchSpan } from './ensembleSketch';

type MusicalRole = 'statement' | 'answer' | 'solo-harmony' | 'support' | 'bass-connection';
interface Target { start: number; duration: number; target: number; role: MusicalRole; lyric: string; motif?: string }
export interface DialogueGesture { voice: string; start: number; end: number; role: MusicalRole; motif?: string; variant?: string }
const IDS = ['voice-s', 'voice-a', 'voice-t', 'voice-b'];
const RANGE = [[62, 76], [55, 69], [48, 64], [40, 55]];
const CENTER = [68, 61, 55, 46];
const pc = (n: number) => (n % 12 + 12) % 12;
const snap = (n: number) => Math.round(n * 2) / 2;
const overlaps = (a: number, b: number, c: number, d: number) => a < d - 1e-6 && b > c + 1e-6;

/** Independent phrases retain an input-derived cell, then pass it between singers.
 * Reference scores inform the musical operations, never supply notes or templates.
 * This is an audition candidate, not an original-backing-vocal transcription. */
export function createMelodicDialogue(source: ScoreProject, span: SketchSpan, options: { harmonicContext?: ChordEvent[] } = {}) {
  const foundation = createEnsembleSketch(source, span).project;
  const bar = beatsPerBar(source), a = (span.first - 1) * bar, b = span.last * bar;
  const lead = source.parts.find(p => p.id === 'solo')!.notes.filter(n => n.midi !== null && overlaps(a, b, n.start, n.start + n.duration)).sort((x, y) => x.start - y.start);
  const stable = lead.filter(n => n.duration >= 0.5);
  if (stable.length < 3) throw Error('A melodic sketch needs at least three stable Solo notes');
  const melodicPcs = new Set(stable.map(n => pc(n.midi!)));
  // An explicit harmonic ablation changes only the pitch search's evidence.
  // Foundation, motif targets and timing still use the original source, so a
  // new chord boundary cannot silently change attacks, duration or participation.
  const chordAt = (t: number) => (options.harmonicContext ?? source.chords).find(c => c.start <= t + 1e-6 && c.start + c.duration > t + 1e-6)
    ?? source.chords.find(c => c.start <= t + 1e-6 && c.start + c.duration > t + 1e-6);
  // Pick a short moving cell, not the first run of repeated pitches. Keep identity
  // throughout the excerpt; phrase endings may extend it, never randomize it.
  const seeds = stable.slice(0, -2).map((_, i) => stable.slice(i, i + 4));
  const seed = seeds.find(ns => ns.length >= 3 && new Set(ns.map(n => n.midi)).size >= 3 && ns.at(-1)!.start - ns[0].start <= 6) ?? stable.slice(0, 4);
  const durations = seed.map(n => Math.min(1.5, Math.max(0.5, snap(n.duration))));
  const contour = [0];
  for (let i = 1; i < seed.length; i++) contour.push(contour[i - 1] + Math.max(-4, Math.min(4, seed[i].midi! - seed[i - 1].midi!)));
  const motifId = `cell-${seed.map(n => n.id).join('-')}`;
  const cellLength = durations.reduce((sum, d) => sum + d, 0);
  // Phrase windows seek a real breath near two bars, rather than restarting at
  // every chord or short Solo hesitation. No song-name/bar-number dispatch.
  const breaths = lead.filter((n, i) => (lead[i + 1]?.start ?? b) - (n.start + n.duration) >= 0.5)
    .map(n => snap(n.start + n.duration));
  const windows: { start: number; end: number }[] = [];
  for (let t = a; t < b - 0.5;) {
    const ideal = Math.min(b, t + bar * 2);
    const candidates = breaths.filter(p => p >= t + bar * 1.5 && p <= t + bar * 2.5 && p <= b);
    let end = candidates.sort((x, y) => Math.abs(x - ideal) - Math.abs(y - ideal))[0] ?? ideal;
    if (b - end < bar) end = b;
    windows.push({ start: t, end }); t = end;
  }
  const planned: Target[][] = IDS.map(() => []);
  const trace: DialogueGesture[] = [];
  const heldPitch = (v: number, t: number) => foundation.parts.find(p => p.id === IDS[v])!.notes.find(n => n.midi !== null && n.start <= t && n.start + n.duration > t)?.midi ?? CENTER[v];
  const addCell = (v: number, start: number, end: number, inversion: boolean, role: MusicalRole, variant: string) => {
    if (end - start < 1.5) return;
    const anchor = heldPitch(v, start);
    let t = start;
    for (let i = 0; i < durations.length && t < end - 0.49; i++) {
      const duration = Math.min(durations[i], end - t);
      planned[v].push({ start: t, duration, target: anchor + contour[i] * (inversion ? -1 : 1), role,
        lyric: i === 0 ? 'Doo' : 'doo', motif: motifId });
      t += duration;
    }
    // The last tone has a destination and a release; do not cycle the cell until
    // the whole window is filled. A later singer can answer while it sustains.
    const tail = planned[v].at(-1)!;
    tail.duration = Math.min(2, end - tail.start);
    trace.push({ voice: IDS[v], start, end: tail.start + tail.duration, role, motif: motifId, variant });
  };
  let lastOwner = -1;
  windows.forEach((w, index) => {
    const room = w.end - w.start;
    const localLead = stable.filter(n => overlaps(w.start, w.end, n.start, n.start + n.duration));
    const mean = localLead.length ? localLead.reduce((sum, n) => sum + n.midi!, 0) / localLead.length : 65;
    const direction = localLead.length > 1 ? Math.sign(localLead.at(-1)!.midi! - localLead[0].midi!) : 0;
    const owners = [0, 1, 2].sort((x, y) => {
      const cost = (v: number) => Math.abs(CENTER[v] - (mean - 7)) * 0.4 + (v === lastOwner ? 5 : 0)
        + (direction > 0 ? v * 0.5 : (2 - v) * 0.5);
      return cost(x) - cost(y);
    });
    const owner = owners[0];
    // Handoff prefers a different register, and remains the same for the whole
    // phrase. We do not rotate notes between singers or require a note quota.
    const answer = owners.slice(1).sort((x, y) => Math.abs(CENTER[y] - CENTER[owner]) - Math.abs(CENTER[x] - CENTER[owner]))[0];
    const start = w.start + (span.intent === 'flow' ? 0.5 : 0);
    const callEnd = Math.min(w.end - 0.5, start + cellLength + 0.5);
    addCell(owner, start, callEnd, false, 'statement', index === 0 ? 'introduce' : 'sequence-return');
    const responseStart = snap(Math.max(start + 2, Math.min(callEnd + 0.5, w.end - cellLength - 0.5)));
    const contrary = direction !== 0 && direction === Math.sign(contour.at(-1)!);
    if (room >= cellLength + 2.5)
      addCell(answer, responseStart, w.end - 0.5, contrary, 'answer', contrary ? 'contrary-answer' : 'imitated-answer');
    // A third singer can join the last stable sung words of a phrase. This is
    // composed harmony, not a claim to have recovered the recording's backing.
    const harmonyVoice = [0, 1, 2].find(v => v !== owner && v !== answer)!;
    const ending = localLead.filter(n => n.start >= w.end - Math.min(4, room / 2)).slice(-4);
    for (const n of ending) {
      const start = Math.max(w.start, snap(n.start)), end = Math.min(w.end - 0.5, snap(n.start + n.duration));
      if (end - start < 0.5) continue;
      const third = CENTER[harmonyVoice] >= n.midi! ? 4 : -4;
      let target = n.midi! + third;
      while (target < RANGE[harmonyVoice][0]) target += 12;
      while (target > RANGE[harmonyVoice][1]) target -= 12;
      planned[harmonyVoice].push({ start, duration: end - start, target, role: 'solo-harmony', lyric: n.lyric || 'Ah' });
    }
    if (ending.length) trace.push({ voice: IDS[harmonyVoice], start: ending[0].start, end: w.end, role: 'solo-harmony' });
    lastOwner = owner;
  });
  // Retain quiet harmonic support outside each voice's melodic phrase, with
  // independent breaths. Support is subordinate to the complete melodic gesture.
  for (let v = 0; v < 4; v++) {
    const part = foundation.parts.find(p => p.id === IDS[v])!;
    const melody = [...planned[v]];
    for (const n of part.notes.filter(n => n.midi !== null && overlaps(a, b, n.start, n.start + n.duration))) {
      let pieces = [{ start: Math.max(a, n.start), end: Math.min(b - 0.5, n.start + n.duration) }];
      for (const m of melody) pieces = pieces.flatMap(p => !overlaps(p.start, p.end, m.start - 0.5, m.start + m.duration + 0.5) ? [p] :
        [{ start: p.start, end: Math.min(p.end, m.start - 0.5) }, { start: Math.max(p.start, m.start + m.duration + 0.5), end: p.end }].filter(q => q.end - q.start >= 1));
      for (const p of pieces) if (p.end - p.start >= 1) planned[v].push({ start: p.start, duration: p.end - p.start, target: n.midi!, role: 'support', lyric: v === 3 ? 'Dm' : 'Ooh' });
    }
    planned[v].sort((x, y) => x.start - y.start);
  }
  // Bass: root landmarks with a stepwise approach to the next actual harmonic
  // destination. Do not copy the upper cell or reiterate every Solo attack.
  const bass = planned[3];
  for (let i = 0; i < bass.length - 1; i++) {
    const n = bass[i], next = bass[i + 1];
    if (n.duration < 3 || Math.abs(n.target - next.target) < 2 || next.start - (n.start + n.duration) > 0.5) continue;
    const end = n.start + n.duration, direction = Math.sign(next.target - n.target);
    n.duration -= 1;
    bass.splice(i + 1, 0, { start: end - 1, duration: 1, target: next.target - direction * 2, role: 'bass-connection', lyric: 'doo', motif: motifId });
    trace.push({ voice: IDS[3], start: end - 1, end, role: 'bass-connection', motif: motifId }); i++;
  }
  const result = structuredClone(source);
  const realized: NoteEvent[][] = IDS.map(() => []);
  // Solve complete horizontal lines, using sounding support/previously solved
  // lines as context. Desired contour has explicit cost, not merely minimum motion.
  for (const v of [3, 2, 1, 0]) {
    const seq = planned[v];
    let beam: { cost: number; pitches: number[] }[] = [{ cost: 0, pitches: [] }];
    seq.forEach((n, i) => {
      const chord = chordAt(n.start), chordPcs = new Set(chord?.pitches.map(pc) ?? []);
      const candidates = Array.from({ length: RANGE[v][1] - RANGE[v][0] + 1 }, (_, k) => RANGE[v][0] + k);
      const next: typeof beam = [];
      for (const pitch of candidates) {
        // A chromatic connection needs input or chord evidence; raw semitone
        // transposition of a cell must not invent arbitrary altered neighbours.
        if (!chordPcs.has(pc(pitch)) && !melodicPcs.has(pc(pitch))) continue;
        const weakConnection = n.role === 'bass-connection' || (n.role !== 'support' && n.duration <= 1 && n.start % 1 !== 0);
        if (!chordPcs.has(pc(pitch)) && !weakConnection && n.role !== 'solo-harmony') continue;
        let local = Math.abs(pitch - n.target) * (n.role === 'support' ? 1 : 2.2);
        if (!chordPcs.has(pc(pitch))) local += weakConnection ? 1.5 : 4;
        for (let other = 0; other < 4; other++) if (other !== v) {
          const context = realized[other].length ? realized[other] : planned[other].map(m => ({ ...m, midi: m.target }));
          for (const m of context) if (overlaps(n.start, n.start + n.duration, m.start, m.start + m.duration)) {
            const interval = Math.abs(pitch - m.midi!);
            const duration = Math.min(n.start + n.duration, m.start + m.duration) - Math.max(n.start, m.start);
            local += duration * (interval === 1 ? 9 : pc(interval) === 1 || pc(interval) === 11 ? 3 : 0);
            if ((v < other && pitch <= m.midi!) || (v > other && pitch >= m.midi!)) local += duration * 8;
          }
        }
        for (const m of lead) if (overlaps(n.start, n.start + n.duration, m.start, m.start + m.duration)) {
          const interval = Math.abs(pitch - m.midi!);
          const duration = Math.min(n.start + n.duration, m.start + m.duration) - Math.max(n.start, m.start);
          local += duration * (interval === 1 ? 8 : pc(interval) === 1 || pc(interval) === 11 ? 2 : 0);
          if (n.role === 'solo-harmony' && ![3, 4, 7, 8, 9].includes(pc(interval))) local += duration * 5;
        }
        let best = beam[0], bestCost = Infinity;
        for (const prev of beam) {
          const last = prev.pitches.at(-1), step = last === undefined ? 0 : pitch - last;
          let cost = prev.cost + local + Math.max(0, Math.abs(step) - 5) ** 2 * 2 + Math.abs(step) * 0.25;
          if (i > 0 && n.motif && seq[i - 1].motif === n.motif && n.role === seq[i - 1].role) {
            const desired = n.target - seq[i - 1].target;
            cost += Math.abs(step - desired) * 2;
            if (desired !== 0 && step === 0) cost += 7;
          }
          if (cost < bestCost) { best = prev; bestCost = cost; }
        }
        next.push({ cost: bestCost, pitches: [...best.pitches, pitch] });
      }
      if (!next.length) throw Error(`No melodic pitch at ${n.start}`);
      beam = next.sort((x, y) => x.cost - y.cost).slice(0, 20);
    });
    realized[v] = seq.map((n, i) => ({ id: `dialogue-${span.first}-${v}-${i}`, start: n.start, duration: n.duration,
      midi: beam[0].pitches[i], velocity: v === 3 ? 0.62 : n.role === 'support' ? 0.5 : 0.61,
      lyric: n.lyric, origin: 'arranged', ...(i === 0 ? { dynamic: 'mp' as const } : {}) }));
    const part = result.parts.find(p => p.id === IDS[v])!;
    const outside = part.notes.flatMap(n => !overlaps(a, b, n.start, n.start + n.duration) ? [n] : [
      ...(n.start < a ? [{ ...n, duration: a - n.start }] : []),
      ...(n.start + n.duration > b ? [{ ...n, id: n.id + '-tail', start: b, duration: n.start + n.duration - b }] : []),
    ]);
    part.notes = [...outside, ...realized[v]].sort((x, y) => x.start - y.start);
    if (v === 2) { part.clef = 'treble8'; if (part.staves) part.staves = part.staves.map(s => ({ ...s, clef: 'treble8' })); }
  }
  const errors = validateProject(result);
  if (errors.length) throw Error(errors.join('\n'));
  return { project: result, trace, seed: { id: motifId, durations, contour }, windows,
    targets: planned.flatMap((ns,v)=>ns.map(n=>({voice: IDS[v], ...n}))) };
}
