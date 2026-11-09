import { Midi } from '@tonejs/midi';
import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { toMidi, validateProject } from '../src/lib/music';
import type { NoteEvent } from '../src/lib/types';

function note(midi: number, options: Partial<NoteEvent> = {}): NoteEvent {
  return { id: `note-${midi}`, midi, start: 1, duration: 2, velocity: .75, ...options };
}

it('keeps measured roll order across staves while unmarked notes play on the beat', () => {
  const project = createBlankProject();
  const part = project.parts[0];
  part.notes = [
    note(55, { arpeggio: true, arpeggioOffset: .2, staff: 2 }),
    note(67, { arpeggio: true, arpeggioOffset: 0, staff: 1 }),
    note(72, { arpeggio: true, arpeggioOffset: .1, staff: 1, voice: '2' }),
    note(76), note(79),
  ];
  const original = structuredClone(part.notes);
  const midi = new Midi(toMidi(project));
  const notes = [...midi.tracks[0].notes].sort((a, b) => a.midi - b.midi);
  expect(notes.map(note => note.ticks / midi.header.ppq)).toEqual([1.2, 1, 1.1, 1, 1]);
  expect(notes.map(note => note.ticks + note.durationTicks)).toEqual(Array(5).fill(3 * midi.header.ppq));
  expect(part.notes).toEqual(original);
});

it('limits a fallback roll when the written chord is short', () => {
  const project = createBlankProject();
  project.parts[0].notes = [
    note(67, { arpeggio: true, duration: .03 }),
    note(60, { arpeggio: true, duration: .03, arpeggioOffset: .01 }),
    note(64, { arpeggio: true, duration: .03 }),
  ];
  const midi = new Midi(toMidi(project));
  const notes = midi.tracks[0].notes;
  expect(notes.map(note => note.midi)).toEqual([60, 64, 67]);
  expect(notes[0].ticks).toBe(midi.header.ppq);
  expect(notes[1].ticks).toBeGreaterThan(notes[0].ticks);
  expect(notes[2].ticks).toBeGreaterThan(notes[1].ticks);
  expect(notes[2].ticks).toBeLessThan(notes[0].ticks + notes[0].durationTicks);
});

it.each([-1, Infinity, '0.1'])('rejects invalid arpeggio offsets (%s)', (offset) => {
  const project = createBlankProject();
  const rolled = note(60, { arpeggio: true });
  Object.assign(rolled, { arpeggioOffset: offset });
  project.parts[0].notes = [rolled];
  expect(validateProject(project)).toContainEqual(expect.stringContaining('琶音'));
});
