import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, pedalMarks, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { pedalSustained, performanceNotes } from '../src/lib/performance';
import type { NoteEvent, ScorePart } from '../src/lib/types';

function piano(): ScorePart {
  const project = createBlankProject();
  const part = project.parts[0];
  Object.assign(part, { role: 'instrument', program: 0, staves: [{ number: 1, clef: 'treble' }, { number: 2, clef: 'bass' }] });
  part.notes = [
    { id: 'a', midi: 48, start: 0, duration: 1, velocity: .8, staff: 2 },
    { id: 'b', midi: 43, start: 1, duration: 1, velocity: .8, staff: 2 },
    { id: 'c', midi: 48, start: 3, duration: 1, velocity: .8, staff: 2 },
    { id: 'd', midi: 72, start: 0, duration: 4, velocity: .8, staff: 1 },
  ] as NoteEvent[];
  part.pedals = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
  return part;
}

describe('sustain pedal (finger gates written, pedal carries the sound)', () => {
  it('prints Ped. and * with a pedal change, in a voice that adds no notes', () => {
    expect(pedalMarks([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 6, end: 7 }])).toEqual([
      { at: 0, label: 'Ped.' }, { at: 2, label: '* Ped.' }, { at: 4, label: '*' }, { at: 6, label: 'Ped.' }, { at: 7, label: '*' },
    ]);
    const project = createBlankProject();
    project.parts = [piano()];
    project.measures = 2;
    expect(validateProject(project)).toEqual([]);
    const result = toAbc(project);
    expect(result.abc).toContain('"_Ped."');
    expect(result.abc).toContain('"_* Ped."');
    const tune = abcjs.parseOnly(result.abc)[0];
    expect(tune.warnings ?? []).toEqual([]);
    // Audio: the pedal voice is silent; decoded notes equal the score notes.
    const audio = tune.setUpAudio({ chordsOff: true });
    const decoded = audio.tracks.flatMap((t) => t.filter((e) => e.cmd === 'note')).length;
    expect(decoded).toBe(4);
  });

  it('extends a released key to the pedal lift or its own restrike in playback only', () => {
    const part = piano();
    const played = pedalSustained(part.notes, part.pedals);
    expect(played.find((n) => n.id === 'a')!.duration).toBe(2);  // pedal 0–2 lifts at 2
    expect(played.find((n) => n.id === 'b')!.duration).toBe(1);  // released at 2, pedal change: the lift ends it
    expect(played.find((n) => n.id === 'c')!.duration).toBe(1);  // ends at 4 with the pedal
    expect(part.notes.find((n) => n.id === 'a')!.duration).toBe(1); // score is unchanged
    expect(performanceNotes(part, 60).find((n) => n.id === 'a')!.duration).toBe(2);
  });

  it('exports pedal directions to MusicXML without changing notes', () => {
    const project = createBlankProject();
    project.parts = [piano()];
    project.measures = 2;
    const xml = toMusicXml(project);
    expect(xml.match(/<pedal type="start"/g)?.length).toBe(1);
    expect(xml.match(/<pedal type="change"/g)?.length).toBe(1);
    expect(xml.match(/<pedal type="stop"/g)?.length).toBe(1);
    expect(fromMusicXml(xml).parts[0].notes.filter((n) => n.midi !== null).length).toBe(4);
  });

  it('rejects malformed pedal intervals', () => {
    const project = createBlankProject();
    project.parts[0].pedals = [{ start: 2, end: 1 }];
    expect(validateProject(project).join('')).toContain('踏板记号无效');
  });
});
