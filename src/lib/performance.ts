import { notesWithActiveDynamics } from './dynamics';
import type { NoteEvent, ScorePart } from './types';

export function performanceNotes(part: ScorePart, tempo: number): NoteEvent[] {
  // Resolve printed dynamics at the written beat before moving any attacks.
  const notes = notesWithActiveDynamics(part);
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
