import { notesWithActiveDynamics } from './dynamics';
import type { NoteEvent, ScorePart } from './types';

/** Damper pedal: a released key keeps sounding while the pedal is down, until
 * the pedal lifts or the same key is struck again. Written values stay the
 * finger gates; only playback length changes. */
export function pedalSustained(notes: NoteEvent[], pedals: ScorePart['pedals']): NoteEvent[] {
  if (!pedals?.length) return notes;
  const nextSamePitch = new Map<number, number[]>();
  for (const note of notes)
    if (note.midi !== null) (nextSamePitch.get(note.midi) ?? nextSamePitch.set(note.midi, []).get(note.midi)!).push(note.start);
  for (const starts of nextSamePitch.values()) starts.sort((a, b) => a - b);
  return notes.map((note) => {
    if (note.midi === null || note.velocity <= 0) return note;
    const release = note.start + note.duration;
    // The pedal must be down at the key release and continue past it. A pedal
    // change exactly at the release lifts the dampers then: no extension.
    const pedal = pedals.find((p) => p.start < release - 1e-6 && p.end > release + 1e-6);
    if (!pedal) return note;
    const restrike = nextSamePitch.get(note.midi)!.find((start) => start > note.start + 1e-6);
    const end = Math.min(pedal.end, restrike ?? Infinity);
    return end > release + 1e-6 ? { ...note, duration: end - note.start } : note;
  });
}

export function performanceNotes(part: ScorePart, tempo: number): NoteEvent[] {
  // Resolve printed dynamics at the written beat before moving any attacks.
  const notes = pedalSustained(notesWithActiveDynamics(part), part.pedalSustain ?? part.pedals);
  if (part.role === 'percussion') return notes;

  const rolls = new Map<number, Array<{ note: NoteEvent; index: number }>>();
  notes.forEach((note, index) => {
    if (!note.arpeggio || note.midi === null || note.velocity <= 0) return;
    const chord = rolls.get(note.start);
    if (chord) chord.push({ note, index });
    else rolls.set(note.start, [{ note, index }]);
  });

  for (const chord of rolls.values()) {
    if (chord.length < 2) continue;
    const measured = chord.every(({ note }) =>
      note.arpeggioOffset !== undefined && Number.isFinite(note.arpeggioOffset) && note.arpeggioOffset >= 0,
    );
    if (!measured) chord.sort((a, b) => a.note.midi! - b.note.midi!);
    const shortest = Math.min(...chord.map(({ note }) => note.duration));
    const spacing = Math.min(.04 * tempo / 60, .18 * tempo / 60 / (chord.length - 1), shortest / 2 / (chord.length - 1));
    const offsets = chord.map(({ note }, index) => measured ? note.arpeggioOffset! : index * spacing);
    // A later edit may shorten a note below its measured delay. Scale the
    // whole roll in that case so the measured attack order still fits.
    const longestRatio = Math.max(...chord.map(({ note }, index) => offsets[index] / note.duration));
    const scale = longestRatio < 1 ? 1 : .5 / longestRatio;
    chord.forEach(({ note, index }, attack) => {
      const delay = offsets[attack] * scale;
      if (delay > 0) notes[index] = { ...note, start: note.start + delay, duration: note.duration - delay };
    });
  }
  return notes;
}
