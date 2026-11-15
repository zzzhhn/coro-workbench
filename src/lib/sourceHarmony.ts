import type { NoteEvent, ScoreProject } from './types';
import { beatsPerBar } from './music';

export interface SourceHarmony {
  start: number;
  duration: number;
  pitches: number[];
  bass: number;
  sourceNoteIds: string[];
}
const pc = (n: number) => ((n % 12) + 12) % 12;
const pitched = (n: NoteEvent): n is NoteEvent & { midi: number } => n.midi !== null;

// A rolled chord still has a shared sounding interval. A scale or short arpeggio
// does not. Do not pool every pitch in a beat into a new invented chord.
function attacks(notes: NoteEvent[]) {
  const ns = notes.filter(pitched).sort((a, b) => a.start - b.start);
  const result: Array<{ start: number; notes: Array<NoteEvent & { midi: number }> }> = [];
  const starts = [...new Set(ns.filter(n => n.duration >= .45)
    .map(n => Math.round(n.start * 2) / 2)
    .filter(t => ns.some(n => Math.abs(n.start - t) <= .16 && n.duration >= .45)))].sort((a, b) => a - b);
  for (const start of starts) {
    const sustained = ns.filter(n => n.start <= start + .3 && n.start + n.duration >= start + .49);
    const arriving = sustained.filter(n => n.start >= start - .16);
    // Two new notes may join a held common tone. A pickup into a block chord
    // must not move the block and its bass a sixteenth earlier.
    if (new Set(arriving.map(n => pc(n.midi))).size >= 2) result.push({ start, notes: sustained });
  }
  return result;
}

/** Read harmonic constraints directly from a reliable accompaniment score.
 * This is a voiced-score reduction, not chord-name recognition. It neither
 * supplies missing thirds nor treats Solo ornaments as harmonic evidence.
 * Unknown/unvoiced regions remain gaps for the caller to review. */
export function extractSourceHarmony(source: ScoreProject, leadPartId: string) {
  if (!source.parts.some(p => p.id === leadPartId)) throw Error('Unknown Solo part');
  const parts = source.parts.filter(p => p.id !== leadPartId && p.role !== 'percussion');
  const ranked = parts.map(part => ({ part, groups: attacks(part.notes) })).sort((a, b) => b.groups.length - a.groups.length);
  if (!ranked[0]?.groups.length) throw Error('No sustained chordal accompaniment; source harmony needs review');
  const harmonic = ranked[0];
  const register = (notes: NoteEvent[]) => {
    const pitches = notes.filter(pitched).map(n => n.midi).sort((a, b) => a - b);
    return pitches.length ? pitches[Math.floor((pitches.length - 1) / 4)] : Infinity;
  };
  const bassPart = [...parts].sort((a, b) => register(a.notes) - register(b.notes))[0];
  const bassCeiling = register(bassPart.notes) + 12;
  const lowNotes = bassPart.notes.filter(pitched).filter(n => n.midi <= bassCeiling);
  const bar = beatsPerBar(source), guides: SourceHarmony[] = [];
  for (let i = 0; i < harmonic.groups.length; i++) {
    const group = harmonic.groups[i], next = harmonic.groups[i + 1];
    // Keep the last actual low-register arrival across a broken chord. A right
    // hand or high left-hand fill cannot silently replace the bass landmark.
    const soundingBass = lowNotes.filter(n => n.start <= group.start + .06 && n.start + n.duration > group.start + .12);
    const priorBass = lowNotes.filter(n => n.start <= group.start && group.start - n.start <= bar * 2)
      .sort((a, b) => b.start - a.start || a.midi - b.midi)[0];
    const bass = soundingBass.sort((a, b) => a.midi - b.midi)[0] ?? priorBass;
    if (!bass) continue;
    // Permit a broken-chord continuation, but never bridge a full beat of
    // accompaniment silence just because the next block chord is far away.
    let end = Math.max(...group.notes.map(n => n.start + n.duration));
    const limit = Math.min(next?.start ?? source.measures * bar, group.start + bar * 2);
    for (const n of harmonic.part.notes.filter(pitched).filter(n => n.start >= group.start && n.start < limit).sort((a, b) => a.start - b.start)) {
      if (n.start - end >= 1 - 1e-6) break;
      end = Math.max(end, n.start + n.duration);
    }
    end = Math.min(limit, end);
    if (limit - end < 1 - 1e-6) end = limit;
    else if (Math.abs(end - Math.round(end * 2) / 2) < .1) end = Math.round(end * 2) / 2;
    const lowerChord = bassPart.notes.filter(pitched).filter(n => n.start <= group.start + .06 && n.start + n.duration >= group.start + .4);
    const pitches = [...new Set([...group.notes, ...lowerChord, bass].map(n => pc(n.midi)))].sort((a, b) => a - b);
    if (pitches.length < 3) continue;
    const last = guides.at(-1);
    const sourceNoteIds = [...new Set([...group.notes, ...lowerChord, bass].map(n => n.id))];
    // Dropping a member on the next accompaniment pulse is not by itself a
    // different harmony. Retain the supported palette until a new tone/bass arrives.
    if (last && last.start + last.duration >= group.start - 1e-6 && last.bass === pc(bass.midi) && pitches.every(p => last.pitches.includes(p))) {
      last.duration = end - last.start;
      last.sourceNoteIds = [...new Set([...last.sourceNoteIds, ...sourceNoteIds])];
    } else if (end > group.start) guides.push({ start: group.start, duration: end - group.start, pitches, bass: pc(bass.midi), sourceNoteIds });
  }
  // A two-note accompaniment event is not always a new harmony. If such an
  // event was rejected, keep the previous context across its short continuation.
  for (let i = 0; i + 1 < guides.length; i++) {
    const g = guides[i], next = guides[i + 1], end = g.start + g.duration;
    if (next.start > end && next.start - end < 1 && harmonic.part.notes.some(n => pitched(n) && n.start < next.start && n.start + n.duration > end)) g.duration = next.start - g.start;
  }
  return { guides, harmonicPartId: harmonic.part.id, bassPartId: bassPart.id };
}
