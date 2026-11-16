import type { NoteEvent, ScoreProject } from './types';
import { extractSourceHarmony, type SourceHarmony } from './sourceHarmony';

const pc = (n: number) => ((n % 12) + 12) % 12;
const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const EPS = 1e-6;
interface Form { name: string; core: number[]; optional: number[]; colors: number[]; complexity: number }
// Core defines identity. Optional fifths/colors can explain the piano without
// becoming four sustained vocal obligations. This is a bounded tonal vocabulary,
// not a claim that chords outside it are illegitimate.
const forms: Form[] = [
  { name: '', core: [0, 4, 7], optional: [], colors: [2, 9], complexity: 0 },
  { name: 'm', core: [0, 3, 7], optional: [], colors: [2, 5], complexity: 0 },
  { name: 'dim', core: [0, 3, 6], optional: [], colors: [], complexity: .5 },
  { name: 'aug', core: [0, 4, 8], optional: [], colors: [], complexity: .8 },
  { name: 'sus2', core: [0, 2, 7], optional: [], colors: [], complexity: .6 },
  { name: 'sus4', core: [0, 5, 7], optional: [], colors: [2], complexity: .6 },
  { name: '7', core: [0, 4, 10], optional: [7], colors: [1, 2, 3, 6, 8, 9], complexity: .4 },
  { name: 'maj7', core: [0, 4, 11], optional: [7], colors: [2, 6, 9], complexity: .4 },
  { name: 'm7', core: [0, 3, 10], optional: [7], colors: [2, 5], complexity: .4 },
  { name: 'mMaj7', core: [0, 3, 11], optional: [7], colors: [2], complexity: .8 },
  { name: 'm7b5', core: [0, 3, 6, 10], optional: [], colors: [], complexity: .6 },
  { name: 'dim7', core: [0, 3, 6, 9], optional: [], colors: [], complexity: .8 },
  { name: '7sus4', core: [0, 5, 10], optional: [7], colors: [2, 9], complexity: .7 },
  { name: '6', core: [0, 4, 9], optional: [7], colors: [2], complexity: .6 },
  { name: 'm6', core: [0, 3, 9], optional: [7], colors: [2], complexity: .6 },
];
interface Candidate {
  root: number; quality: string; core: number[]; allowed: number[];
  colors: number[]; excluded: number[]; cost: number; symbol: string;
  inferredCore: number[];
  nonChordTones: Array<{ noteId: string; pitch: number; role: 'possible-passing' | 'possible-neighbor' | 'possible-suspension' | 'unexplained' }>;
}
export interface HarmonicDecision {
  start: number; duration: number; bass: number; sourcePitches: number[];
  status: 'interpreted' | 'review'; reason?: string;
  selected?: Candidate; alternatives: Array<{ symbol: string; cost: number }>;
}

const overlap = (n: NoteEvent, a: number, b: number) => Math.max(0, Math.min(b, n.start + n.duration) - Math.max(a, n.start));

/** Harmonic interpretation precedes voicing. The phrase-level path uses actual
 * source evidence, stable Solo notes and adjacent candidates, never bar IDs,
 * guessed key metadata, a reference arrangement or previous generated notes. */
export function interpretSourceHarmony(source: ScoreProject, leadPartId: string) {
  const evidence = extractSourceHarmony(source, leadPartId, { mergeOmissions: false, includeDyads: true });
  const lead = source.parts.find(p => p.id === leadPartId)!.notes.filter(n => n.midi !== null);
  const accompaniment = source.parts.filter(p => [evidence.harmonicPartId, evidence.bassPartId].includes(p.id)).flatMap(p => p.notes);
  const bassNotes = source.parts.find(p => p.id === evidence.bassPartId)!.notes.filter(n => n.midi !== null);
  const bassRegister = bassNotes.map(n => n.midi!).sort((a, b) => a - b);
  const bassCeiling = bassRegister[Math.floor((bassRegister.length - 1) / 4)] + 12;
  // Reobserve on beats as well as source attacks. A palette held by the legacy
  // extractor must not borrow a later note and pretend it sounded at its start.
  const events = evidence.guides.flatMap(g => {
    const stop = g.start + g.duration;
    const cuts = [g.start];
    for (let t = Math.floor(g.start) + 1; t < stop - EPS; t++) cuts.push(t);
    cuts.push(stop);
    return cuts.slice(0, -1).map((start, i) => {
      const sounding = bassNotes.filter(n => n.midi! <= bassCeiling && n.start <= start + .06 && n.start + n.duration > start + .12);
      const bass = sounding.length ? pc(Math.min(...sounding.map(n => n.midi!))) : g.bass;
      return { ...g, start, duration: cuts[i + 1] - start, bass };
    });
  });
  const layers: Candidate[][] = [];
  events.forEach((g, eventIndex) => {
    const support = new Map<number, number>();
    const arrival = new Set<number>();
    for (const n of accompaniment) if (n.midi !== null) {
      const length = overlap(n, g.start, g.start + g.duration);
      if (length) {
        support.set(pc(n.midi), Math.max(support.get(pc(n.midi)) ?? 0, length / g.duration));
        if (n.start <= g.start + .3 && n.start + n.duration > g.start + .3) arrival.add(pc(n.midi));
      }
    }
    // The guide preserves bass landmarks in broken-chord textures.
    support.set(g.bass, 1);
    arrival.add(g.bass);
    const stableLead = lead.filter(n => n.duration >= .5 && overlap(n, g.start, g.start + g.duration) >= .25);
    const leadSupport = new Map<number, number>();
    for (const n of stableLead) leadSupport.set(pc(n.midi!), (leadSupport.get(pc(n.midi!)) ?? 0) + overlap(n, g.start, g.start + g.duration) / g.duration);
    const observed = new Set([...support].filter(([p, w]) => w >= .15 && arrival.has(p)).map(([p]) => p));
    // A stable Solo can supply the root of a rootless piano voicing. An isolated
    // short ornament cannot license a new background chord member.
    const grounded = new Set([...observed, ...[...leadSupport].filter(([, w]) => w >= .2).map(([p]) => p)]);
    const candidates: Candidate[] = [];
    for (let root = 0; root < 12; root++) for (const form of forms) {
      let core = form.core.map(d => pc(root + d));
      let inferredCore: number[] = [];
      const previousEvent = events[eventIndex - 1];
      const missing = core.filter(p => !grounded.has(p));
      if (missing.length === 1 && previousEvent?.bass === g.bass && Math.abs(previousEvent.start + previousEvent.duration - g.start) < EPS) {
        const previous = layers[eventIndex - 1]?.find(c => c.root === root && c.quality === form.name && !c.inferredCore.length
          && missing.every(p => c.core.includes(p)) && [...grounded].every(p => [...c.allowed, ...c.colors].includes(p)));
        if (previous) inferredCore = missing;
      }
      const incompleteTriad = (form.name === '' || form.name === 'm') && core.slice(0, 2).every(p => grounded.has(p)) && !grounded.has(core[2]);
      if (incompleteTriad && !inferredCore.length) core = core.slice(0, 2);
      if (!core.every(p => grounded.has(p) || inferredCore.includes(p))) continue;
      const optional = form.optional.map(d => pc(root + d)).filter(p => observed.has(p));
      const colors = form.colors.map(d => pc(root + d)).filter(p => observed.has(p));
      const explained = new Set([...core, ...optional, ...colors]);
      // A non-chord bass is allowed as explicit pedal/slash evidence, not silently
      // promoted to root. More than four obligatory tones is not realizable here.
      if (new Set([...core, g.bass]).size > 4) continue;
      let cost = form.complexity + (incompleteTriad && !inferredCore.length ? 1.25 : 0) + inferredCore.length * .35
        + (core.includes(g.bass) ? 0 : optional.includes(g.bass) ? .15 : colors.includes(g.bass) ? .65 : 1.8);
      const excluded: number[] = [];
      for (const [p, weight] of support) {
        if (explained.has(p)) { if (colors.includes(p)) cost += weight * .65; continue; }
        if (p === g.bass) continue; // Explicit slash/pedal, already penalized above.
        excluded.push(p);
        // An audible sustained non-member is expensive. The next stage still
        // reports it; this cost is not a claim to have proved ornamentation.
        cost += weight * 4;
      }
      for (const [p, weight] of leadSupport) {
        const relative = pc(p - root);
        const soloFits = explained.has(p) || form.colors.includes(relative);
        if (!soloFits) cost += weight * 4;
        else if (!core.includes(p) && !optional.includes(p)) cost += weight * 1.5;
        // A stable semitone against an obligatory harmony tone is not waived
        // simply because both appeared in the original score.
        if (!core.includes(p) && core.some(c => [1, 11].includes(pc(c - p)))) cost += weight * 2;
      }
      const bassSuffix = g.bass === root ? '' : '/' + names[g.bass];
      const nonChordTones: Candidate['nonChordTones'] = [];
      for (const part of source.parts.filter(p => [evidence.harmonicPartId, evidence.bassPartId].includes(p.id))) {
        for (const n of part.notes) if (n.midi !== null && excluded.includes(pc(n.midi)) && overlap(n, g.start, g.start + g.duration) > 0) {
          const before = part.notes.filter(b => b.midi !== null && Math.abs(b.start + b.duration - n.start) < .15 && Math.abs(b.midi - n.midi!) <= 2);
          const after = part.notes.filter(a => a.midi !== null && Math.abs(a.start - n.start - n.duration) < .15 && Math.abs(a.midi - n.midi!) <= 2 && core.includes(pc(a.midi)));
          let role: Candidate['nonChordTones'][number]['role'] = 'unexplained';
          if (n.duration <= .5 && before.some(b => after.some(a => b.midi === a.midi && b.midi !== n.midi))) role = 'possible-neighbor';
          else if (n.duration <= .5 && before.some(b => after.some(a => (n.midi! - b.midi!) * (a.midi! - n.midi!) > 0))) role = 'possible-passing';
          else if (n.start < g.start && after.some(a => a.midi! < n.midi!)) role = 'possible-suspension';
          nonChordTones.push({ noteId: n.id, pitch: pc(n.midi), role });
        }
      }
      candidates.push({ root, quality: form.name, core, allowed: [...new Set([...core, ...optional, g.bass])], colors,
        inferredCore, excluded, nonChordTones, cost, symbol: names[root] + form.name + bassSuffix });
    }
    layers.push(candidates.sort((a, b) => a.cost - b.cost || a.symbol.localeCompare(b.symbol)).slice(0, 12));
  });
  // Dynamic programming, reset at evidence gaps. Prefer persistence/common tones
  // and ordinary fourth/fifth root motion without forcing every chord into it.
  const chosen = new Map<number, Candidate>();
  for (let first = 0; first < events.length;) {
    if (!layers[first].length) { first++; continue; }
    let last = first;
    while (last + 1 < events.length && layers[last + 1].length && events[last].start + events[last].duration >= events[last + 1].start - EPS) last++;
    let paths = layers[first].map(c => ({ cost: c.cost * Math.min(events[first].duration, 2), path: [c] }));
    for (let i = first + 1; i <= last; i++) paths = layers[i].map(c => {
      const best = paths.map(p => {
        const prior = p.path.at(-1)!;
        const same = prior.root === c.root && prior.quality === c.quality;
        const common = prior.core.filter(n => c.core.includes(n)).length;
        const motion = pc(c.root - prior.root);
        const transition = same ? 0 : .7 + Math.max(0, 2 - common) * .25 - ([5, 7].includes(motion) ? .35 : 0)
          + (events[i].bass === events[i - 1].bass ? 1.5 : 0);
        return { cost: p.cost + transition + c.cost * Math.min(events[i].duration, 2), path: [...p.path, c] };
      }).sort((a, b) => a.cost - b.cost)[0];
      return best;
    });
    paths.sort((a, b) => a.cost - b.cost)[0].path.forEach((c, j) => chosen.set(first + j, c));
    first = last + 1;
  }
  const guides: SourceHarmony[] = [], decisions: HarmonicDecision[] = [];
  events.forEach((g, i) => {
    const c = chosen.get(i);
    // Review is an explicit unresolved hypothesis, never a musical pass/fail score.
    const nearTie = layers[i].some(other => other !== c && Math.abs(other.cost - (c?.cost ?? 0)) < .25);
    const reason = !c ? 'No supported chord identity in the bounded vocabulary' : c.excluded.length ? 'Sustained source tones excluded; interpretation needs review'
      : c.inferredCore.length ? 'Omitted core inferred from adjacent same-bass harmony' : nearTie ? 'Multiple plausible roots or qualities' : undefined;
    decisions.push({ start: g.start, duration: g.duration, bass: g.bass, sourcePitches: g.pitches,
      status: reason ? 'review' : 'interpreted', reason, selected: c,
      alternatives: layers[i].slice(0, 3).map(x => ({ symbol: x.symbol, cost: x.cost })) });
    if (!c) return;
    const guide = { ...g, pitches: c.allowed, root: c.root, quality: c.quality, required: c.core };
    const tail = guides.at(-1);
    if (tail && Math.abs(tail.start + tail.duration - g.start) < EPS && tail.root === guide.root && tail.quality === guide.quality && tail.bass === guide.bass && tail.required?.join() === guide.required.join()) {
      // Omitted optional fifths do not force another vocal attack. Retain only
      // shared supported tones, never an earlier non-member that disappeared.
      tail.pitches = tail.pitches.filter(p => guide.pitches.includes(p));
      tail.duration += g.duration; tail.sourceNoteIds = [...new Set([...tail.sourceNoteIds, ...g.sourceNoteIds])];
    } else guides.push(guide);
  });
  return { ...evidence, guides, decisions };
}
