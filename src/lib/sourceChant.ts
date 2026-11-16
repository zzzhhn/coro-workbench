import type { NoteEvent, ScoreProject } from './types';
import { beatsPerBar } from './music';
import { planPhraseChant, type ChantRegion } from './phraseChant';
import { prepareSourceNotes, transferSourceToSatb } from './sourceTransfer';

const EPS = 1e-6;
const pc = (m: number) => (m % 12 + 12) % 12;
type Pitched = NoteEvent & { midi: number };
export interface ChantAnchor {
  start: number; duration: number; bass: number; upper: number[];
  sourceUpper: number[]; omitted: number[];
  sourceNoteIds: string[]; reason: 'chord-arrival' | 'bass-arrival';
}

function reduceUpper(upper: number[], bass: number, preserveGuideTones = false, vocalCore = false): { upper: number[]; omitted: number[] } {
  const distinct = [...new Map([...upper].sort((a, b) => b - a).map(m => [pc(m), m])).values()];
  if (vocalCore) {
    const intervals = new Set(distinct.map(m => pc(m - bass)));
    const third = intervals.has(3) || intervals.has(4), seventh = intervals.has(10) || intervals.has(11);
    const supportedNinth = (third && (intervals.has(7) || seventh))
      || (seventh && (intervals.has(5) || intervals.has(6)));
    // Sustained humming need not expose every piano extension. Retain the
    // source shell; do not turn sixth chords into triads or guess absent tones.
    const core = distinct.filter(m => !(pc(m - bass) === 2 && supportedNinth)
      && !(pc(m - bass) === 9 && third && seventh));
    const reduced = reduceUpper(core, bass, true);
    return { upper: reduced.upper, omitted: distinct.filter(m => pc(m) !== bass
      && !reduced.upper.some(kept => pc(kept) === pc(m))).map(pc) };
  }
  if (new Set([bass, ...distinct.map(pc)]).size <= 4) return { upper: distinct, omitted: [] as number[] };
  const candidates: number[][] = [];
  const nonBass = distinct.filter(m => pc(m) !== bass);
  if (preserveGuideTones) {
    // Four singers cannot retain every extension. Preserve the source's
    // third/seventh (or suspension when no third is present) before colors.
    // Pitch-class priority must not change when the piano changes register.
    // This is a bass-relative reduction, not a claim to know the chord root.
    const hasThird = nonBass.some(m => [3, 4].includes(pc(m - bass)));
    const priority = (m: number) => {
      const interval = pc(m - bass);
      if ([3, 4].includes(interval) || (!hasThird && interval === 5)) return 0;
      if ([10, 11].includes(interval)) return 1;
      if ([6, 7].includes(interval) || (!hasThird && interval === 2)) return 2;
      return 3;
    };
    const selected = [...nonBass].sort((a, b) => priority(a) - priority(b) || pc(a - bass) - pc(b - bass)).slice(0, 3);
    return { upper: selected, omitted: nonBass.filter(m => !selected.includes(m)).map(pc) };
  }
  // Prefer a complete triad already written in the upper structure over an
  // arbitrary cluster of the three highest notes. Never supply missing tones.
  for (let i = 0; i < nonBass.length; i++) for (let j = i + 1; j < nonBass.length; j++) for (let k = j + 1; k < nonBass.length; k++) {
    const triad = [nonBass[i], nonBass[j], nonBass[k]];
    if (triad.some(root => [[0, 4, 7], [0, 3, 7], [0, 3, 6]].some(form => form.every(d => triad.some(m => pc(m - root) === d))))) candidates.push(triad);
  }
  // When several written triads fit, avoid adding a semitone/whole-tone color
  // above the bass if a plainer source-supported alternative exists. This is a
  // reduction preference, not proof of the original chord's root or function.
  const colorCost = (triad: number[]) => triad.reduce((sum, m) => sum + (pc(m - bass) === 1 ? 3 : pc(m - bass) === 2 ? 1 : 0), 0);
  const selected = candidates.sort((a, b) => colorCost(a) - colorCost(b) || b.reduce((s, m) => s + m, 0) - a.reduce((s, m) => s + m, 0))[0] ?? nonBass.slice(0, 3);
  return { upper: selected, omitted: distinct.filter(m => pc(m) !== bass && !selected.some(s => pc(s) === pc(m))).map(pc) };
}

/** Reduce a reliable accompaniment to harmonic arrivals before distributing it.
 * Explicit staff selection; no chord vocabulary, Solo harmony, or tune lookup.
 * Single-note fills never define upper harmony. Bass figures are represented by
 * their on-beat low arrivals, rather than every note of the figure. */
export function createSourceChant(
  scaffold: ScoreProject, source: ScoreProject,
  selection: { accompanimentIds: string[]; bassPartId: string },
  spans: Array<{ first: number; last: number }>,
  options: { rhythm?: 'phrase-pulse'; blockBars?: number; harmony?: 'sustained-bass' | 'vocal-core' } = {},
) {
  const bar = beatsPerBar(source);
  if (!selection.accompanimentIds.includes(selection.bassPartId)) throw Error('Bass staff must belong to selected accompaniment');
  const prepared = prepareSourceNotes(source, selection.accompanimentIds, { collapseRolledChords: true, reducePerformedGraceNotes: true });
  const bassIds = new Set(source.parts.find(p => p.id === selection.bassPartId)!.notes.map(n => n.id));
  const low = prepared.notes.filter(n => bassIds.has(n.id));
  const high = prepared.notes.filter(n => !bassIds.has(n.id));
  const allCoverage: ChantRegion[] = [];
  const bassRoleDecisions: Array<{ start: number; sourceNoteIds: string[]; heldBass: number; compingMidi: number }> = [];
  const anchors: ChantAnchor[] = [], breaths: Array<{ start: number; end: number }> = [];
  const control = structuredClone(source);
  const template = source.parts.find(p => selection.accompanimentIds.includes(p.id))!;
  control.parts = [{ ...structuredClone(template), id: 'chant-source-reduction', notes: [] }];
  const controlNotes = control.parts[0].notes;
  for (const span of spans) {
    const a = (span.first - 1) * bar, b = span.last * bar;
    const ns = prepared.notes.filter(n => n.start < b && n.start + n.duration > a);
    const starts = [...new Set([a, ...ns.map(n => n.start).filter(t => t >= a && t < b)])].sort((x, y) => x - y);
    const local: ChantAnchor[] = [];
    let bass: Pitched | undefined, upper: Pitched[] = [];
    for (const t of starts) {
      const arriving = (n: Pitched) => Math.abs(n.start - t) < EPS || (t === a && n.start < a && n.start + n.duration > a);
      const freshLow = low.filter(arriving).sort((x, y) => x.midi - y.midi);
      const freshHigh = high.filter(n => arriving(n) && n.start + n.duration - t >= .45);
      const stableLow = freshLow.filter(n => n.duration >= .45);
      const blockHigh = new Set(freshHigh.map(n => pc(n.midi))).size >= 2;
      const blockLow = new Set(stableLow.map(n => pc(n.midi))).size >= 2;
      // Bass plus one sustained melody tone can establish a sparse harmony at
      // a structural beat, but an isolated upper fill cannot replace a chord.
      const onBeat = Math.abs(t - Math.round(t)) < EPS;
      const sparse = onBeat && freshHigh.length > 0 && stableLow.length > 0;
      const chordArrival = blockHigh || blockLow || sparse;
      const lowArrival = freshLow[0];
      // A high approach immediately confirmed an octave down is evidence of
      // a genuine bass move, not an upper-voicing replacement.
      const confirmedBassMove = lowArrival && low.some(n => n.start > t + EPS && n.start <= t + 1 + EPS
        && n.duration >= .45 && pc(n.midi) === pc(lowArrival.midi) && n.midi <= lowArrival.midi - 12);
      // A piano's left hand is not a monophonic bass part. A large upward
      // leap into the chord register inside a continuous measure can complete
      // the upper structure without replacing its low foundation. This opt-in
      // inference is logged; bar starts and genuinely low moves remain anchors.
      const comping = options.harmony !== undefined && !confirmedBassMove && bass && lowArrival && upper.length > 0
        && Math.abs(t / bar - Math.round(t / bar)) > EPS
        && lowArrival.midi - bass.midi >= 10 && lowArrival.midi >= Math.min(...upper.map(n => n.midi)) - 12
        && (blockHigh || blockLow) && ns.some(n => n.start < t && n.start + n.duration >= t - EPS);
      if (comping && bass) bassRoleDecisions.push({ start: t, sourceNoteIds: freshLow.map(n => n.id), heldBass: bass.midi, compingMidi: lowArrival.midi });
      const bassArrival = !comping && lowArrival && (chordArrival || (onBeat && lowArrival.duration >= .45
        && (!bass || lowArrival.midi <= bass.midi + 12)));
      if (!chordArrival && !bassArrival) continue;
      if (bassArrival) bass = lowArrival;
      if (!bass) bass = low.filter(n => n.start <= t && n.start + n.duration > t).sort((x, y) => x.midi - y.midi)[0];
      if (!bass) continue;
      const arrivingUpper = [...freshHigh, ...stableLow.filter(n => comping || n !== lowArrival)];
      if (chordArrival && arrivingUpper.length) {
        const sameBass = local.at(-1)?.bass === pc(bass.midi);
        const subset = arrivingUpper.every(n => upper.some(old => pc(old.midi) === pc(n.midi)));
        // A repeated pulse omitting a member doesn't create a new harmony.
        if (!sameBass || !subset) upper = arrivingUpper;
      }
      if (!upper.length) continue; // no invented triad under an unaccompanied bass
      const pitches = [...new Set(upper.map(n => n.midi))];
      const last = local.at(-1);
      if (last && last.bass === pc(bass.midi) && pitches.every(m => last.sourceUpper.some(old => pc(old) === pc(m)))
        && last.sourceUpper.every(m => pitches.some(old => pc(old) === pc(m)))) continue;
      const reduction = reduceUpper(pitches, pc(bass.midi), options.harmony !== undefined, options.harmony === 'vocal-core');
      local.push({ start: t, duration: 0, bass: pc(bass.midi), ...reduction, sourceUpper: pitches,
        sourceNoteIds: [...new Set([bass.id, ...upper.map(n => n.id)])], reason: chordArrival ? 'chord-arrival' : 'bass-arrival' });
    }
    // A fill can continue the accompaniment but never changes its harmony.
    // An actual half-beat-or-longer accompaniment silence remains a rest.
    const coverage: Array<{ start: number; end: number }> = [];
    for (const n of [...ns].sort((x, y) => x.start - y.start)) {
      const start = Math.max(a, n.start), end = Math.min(b, n.start + n.duration), tail = coverage.at(-1);
      if (tail && start - tail.end < .5 - EPS) tail.end = Math.max(tail.end, end);
      else coverage.push({ start, end });
    }
    allCoverage.push(...coverage);
    for (let i = 0; i < local.length; i++) {
      const g = local[i]; g.duration = (local[i + 1]?.start ?? b) - g.start;
      anchors.push(g);
    }
    if (options.rhythm === 'phrase-pulse') continue;
    // Breath budget is explicit, not inherited from the piano's reattacks.
    // Prefer an existing Solo gap before a bar line; otherwise release half a
    // beat at a bar line after at most two measures of continuous humming.
    const lead = scaffold.parts.find(p => p.id === 'solo')?.notes.filter(n => n.midi !== null) ?? [];
    const canBreathe = (stop: number) => local.some(g => g.start <= stop - 1 + EPS && g.start + g.duration >= stop - EPS);
    let leadEnd = -Infinity;
    for (const n of [...lead].sort((x, y) => x.start - y.start)) {
      const nextBar = Math.ceil(n.start / bar) * bar;
      if (n.start - leadEnd >= .5 - EPS && nextBar - n.start > EPS && nextBar - n.start <= .25 + EPS
        && nextBar > a && nextBar < b && canBreathe(nextBar)) breaths.push({ start: nextBar - .5, end: nextBar });
      leadEnd = Math.max(leadEnd, n.start + n.duration);
    }
    for (const c of coverage) {
      let lastBreath = c.start;
      while (lastBreath + bar * 2 < c.end - EPS) {
        const t = lastBreath + bar * 2;
        const existing = breaths.filter(r => r.end > lastBreath && r.end <= t && r.start >= c.start).sort((x, y) => y.end - x.end)[0];
        if (existing) { lastBreath = existing.end; continue; }
        const candidates = [t, t - .5, t - 1, t - 1.5, t - 2].filter(stop => stop - .5 > lastBreath
          && canBreathe(stop));
        // Never consume an entire short but genuine harmony to make a rest.
        if (!candidates.length) break;
        const end = candidates.find(stop => !lead.some(n => n.start < stop && n.start + n.duration > stop - .5))
          ?? candidates.find(stop => local.some(g => g.duration >= 1.5 && g.start <= stop - 1 + EPS && g.start + g.duration >= stop - EPS))
          ?? candidates[0];
        breaths.push({ start: end - .5, end }); lastBreath = end;
      }
    }
    for (const g of local) for (const c of coverage) {
      if (g.start < c.start - EPS) continue; // never carry a pre-rest chord into a new phrase
      const start = Math.max(g.start, c.start), end = Math.min(g.start + g.duration, c.end);
      if (end - start < .5 - EPS) continue;
      let regions = [{ start, end }];
      for (const breath of breaths) regions = regions.flatMap(r => breath.end <= r.start || breath.start >= r.end ? [r] : [
        ...(breath.start - r.start >= .5 - EPS ? [{ start: r.start, end: breath.start }] : []),
        ...(r.end - breath.end >= .5 - EPS ? [{ start: breath.end, end: r.end }] : []),
      ]);
      let bassMidi = 36 + g.bass;
      while (bassMidi >= Math.min(...g.upper)) bassMidi -= 12;
      for (const r of regions) for (const midi of [bassMidi, ...g.upper]) controlNotes.push({
        id: `chant-core-${r.start}-${midi}`, start: r.start, duration: r.end - r.start, midi, velocity: .48,
      });
    }
  }
  const phrase = options.rhythm === 'phrase-pulse' ? planPhraseChant(anchors, allCoverage,
    spans.map(s => ({ start: (s.first - 1) * bar, end: s.last * bar })), bar, source.tempo, options.blockBars) : undefined;
  if (phrase) {
    breaths.push(...phrase.breaths);
    for (const r of phrase.events) {
      const g = r.anchor;
      let bassMidi = 36 + g.bass;
      while (bassMidi >= Math.min(...g.upper)) bassMidi -= 12;
      for (const midi of [bassMidi, ...g.upper]) controlNotes.push({
        id: `chant-pulse-${r.start}-${midi}`, start: r.start, duration: r.end - r.start, midi, velocity: .48,
      });
    }
  }
  const result = transferSourceToSatb(scaffold, control, ['chant-source-reduction'], spans, {
    connectCommonTones: options.rhythm !== 'phrase-pulse', voiceRanges: [[64, 76], [57, 69], [50, 64], [40, 55]],
    melodyPartId: options.harmony === 'vocal-core' ? 'solo' : undefined,
  });
  return { ...result, anchors, breaths, bassRoleDecisions, phraseBlocks: phrase?.blocks, preprocessing: { rolls: prepared.rolls, ornaments: prepared.ornaments } };
}
