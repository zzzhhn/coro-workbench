import type { NoteEvent, ScorePart } from './types';

const LEVELS = { pp: .4, p: .52, mp: .67, mf: .8, f: .93, ff: 1 };

export function notePlaybackLevel(note: NoteEvent): number {
  return note.velocity * (note.dynamic ? LEVELS[note.dynamic] : .85);
}

/** Resolve performance state without adding printed markings to the score. */
export function notesWithActiveDynamics(part: ScorePart): NoteEvent[] {
  type Mark = { time: number; value: NonNullable<NoteEvent['dynamic']> };
  const staffs = new Map<number, Mark>();
  const voices = new Map<string, Mark>();
  const sorted = part.notes.map((note, index) => ({ note, index })).sort((a, b) => a.note.start - b.note.start);
  const output = [...part.notes];
  for (let first = 0; first < sorted.length;) {
    let last = first + 1;
    while (last < sorted.length && Math.abs(sorted[last].note.start - sorted[first].note.start) < 1e-7) last++;
    // Apply simultaneous markings first, so every note of a chord receives it.
    for (let i = first; i < last; i++) {
      const { note } = sorted[i];
      if (!note.dynamic) continue;
      const staff = note.staff ?? 1;
      const mark = { time: note.start, value: note.dynamic };
      if (note.dynamicScope === 'voice') voices.set(`${staff}:${note.voice ?? '1'}`, mark);
      else staffs.set(staff, mark);
    }
    for (let i = first; i < last; i++) {
      const { note, index } = sorted[i];
      const staff = staffs.get(note.staff ?? 1);
      const voice = voices.get(`${note.staff ?? 1}:${note.voice ?? '1'}`);
      const mark = voice && (!staff || voice.time >= staff.time) ? voice : staff;
      if (mark && !note.dynamic) output[index] = { ...note, dynamic: mark.value };
    }
    first = last;
  }
  return output;
}
