import { describe, expect, it } from 'vitest';
import { parseMidi } from 'midi-file';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toMusicXml, toMidi } from '../src/lib/music';
import { notePlaybackLevel, notesWithActiveDynamics } from '../src/lib/dynamics';
import type { NoteEvent } from '../src/lib/types';

const note = (id: string, start: number, extra: Partial<NoteEvent> = {}): NoteEvent => ({ id, midi: 60, start, duration: 1, velocity: .75, ...extra });
const pianoXml = '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><dynamics><p/></dynamics></direction-type></direction>' + Array.from({length:4}, () => '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>').join('') + '</measure></part></score-partwise>';

describe('persistent dynamic playback', () => {
  it('keeps an imported p active for the phrase without duplicating printed marks', () => {
    const project = fromMusicXml(pianoXml);
    const original = structuredClone(project);
    const notes = notesWithActiveDynamics(project.parts[0]);
    expect(notes.map(notePlaybackLevel)).toEqual([.39, .39, .39, .39]);
    expect(project).toEqual(original);
    const xml = toMusicXml(project);
    expect(xml.match(/<p\/>/g)).toHaveLength(1);
    const restoredLevels = notesWithActiveDynamics(fromMusicXml(xml).parts[0]).map(notePlaybackLevel);
    expect(new Set(restoredLevels).size).toBe(1);
    for (const level of restoredLevels) expect(level).toBeCloseTo(.39, 2);
    const velocities = parseMidi(toMidi(project)).tracks.flat().filter((e) => e.type === 'noteOn').map((e) => e.velocity);
    expect(new Set(velocities).size).toBe(1);
    expect(velocities[0] / 127).toBeCloseTo(.39, 2);
  });
  it('changes at the next marking and honors a later staff mark over earlier voice state', () => {
    const part = createBlankProject().parts[0];
    part.notes = [note('p', 0, { dynamic: 'p', dynamicScope: 'voice', voice: '1' }), note('same', 1, { voice: '1' }),
      note('f', 2, { dynamic: 'f', dynamicScope: 'staff', voice: '2' }), note('later', 3, { voice: '1' })];
    expect(notesWithActiveDynamics(part).map((n) => n.dynamic)).toEqual(['p', 'p', 'f', 'f']);
  });
  it('does not leak voice or staff-specific dynamics into unrelated streams', () => {
    const part = createBlankProject().parts[0];
    part.notes = [note('v1', 0, { voice: '1', staff: 1, dynamic: 'p', dynamicScope: 'voice' }),
      note('v2', 0, { voice: '2', staff: 1 }), note('lower', 0, { staff: 2 }), note('v1-later', 1, { voice: '1', staff: 1 })];
    expect(notesWithActiveDynamics(part).map((n) => n.dynamic)).toEqual(['p', undefined, undefined, 'p']);
  });
  it('applies a simultaneous staff mark to every chord pitch even in unsorted input', () => {
    const part = createBlankProject().parts[0];
    part.notes = [note('later', 2), note('top', 0, { midi: 64 }), note('mark', 0, { dynamic: 'mp' })];
    expect(notesWithActiveDynamics(part).map((n) => n.dynamic)).toEqual(['mp', 'mp', 'mp']);
  });
  it.each(['staff', 'voice'] as const)('preserves %s dynamic scope through MusicXML', (scope) => {
    const project = createBlankProject();
    project.measures = 1;
    project.parts[0].notes = [note('a', 0, { voice: '1', dynamic: 'p', dynamicScope: scope }),
      note('b', 0, { voice: '2', midi: 64 }), note('c', 1, { voice: '1' }), note('d', 1, { voice: '2', midi: 64 })];
    const restored = fromMusicXml(toMusicXml(project));
    const performed = notesWithActiveDynamics(restored.parts[0]).filter((n) => n.midi !== null);
    expect(performed.filter((n) => n.voice === '1').every((n) => n.dynamic === 'p')).toBe(true);
    expect(performed.filter((n) => n.voice === '2').every((n) => n.dynamic === (scope === 'staff' ? 'p' : undefined))).toBe(true);
  });
});
