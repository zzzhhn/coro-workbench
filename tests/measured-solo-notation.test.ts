import abcjs from 'abcjs';
import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { projectMeasuredSoloNotation } from '../src/lib/midiNotation';
import { fromMusicXml, toAbc, toMusicXml } from '../src/lib/music';
import type { NoteEvent } from '../src/lib/types';

type TimedNote = [start: number, duration: number, midi?: number];

function measuredSolo(timing: TimedNote[], phase = 0) {
  const project = createBlankProject();
  const solo = project.parts[0];
  solo.id = 'solo';
  solo.notes = timing.map(([start, duration, midi = 60], index) => ({
    id: `note-${index}`, start: start + phase, duration, midi, velocity: 0.8,
  }));
  project.parts.push({ ...solo, id: 'alto', role: 'harmony', notes: [{
    id: 'alto-note', midi: 64, start: 0, duration: 1, velocity: 0.8,
  }] });
  project.source.kind = 'midi';
  project.arrangement = {
    options: { preset: 'solo-satb', style: 'pop', difficulty: 'medium', percussion: false, transpose: 0 },
    report: { warnings: [], changes: [], ranges: [] },
  };
  return project;
}

const timed = (notes: NoteEvent[]) => notes.filter((note) => note.midi !== null)
  .map(({ midi, start, duration }) => [midi, +start.toFixed(6), +duration.toFixed(6)]);

describe('Measured MIDI Solo notation', () => {
  it('engraves supported short gates, overlaps and barlines consistently in ABC and MusicXML', () => {
    const raw = measuredSolo([
      [0, 0.54], [0.5, 0.56], [1, 0.706, 62], [2, 0.54],
      [3, 0.433, 65], [3.5, 0.498], [4, 0.844], [5, 0.456],
      [5.5, 0.35], [6, 0.556], [7, 0.567],
    ], 1 / 240);
    const before = structuredClone(raw);
    const projected = projectMeasuredSoloNotation(raw);
    expect(projectMeasuredSoloNotation(projected)).toBe(projected);
    expect(raw).toEqual(before);
    expect(projected.parts[1]).toBe(raw.parts[1]);
    expect(projected.parts[0].notes.map((note) => note.id)).toEqual(raw.parts[0].notes.map((note) => note.id));
    expect(timed(projected.parts[0].notes)).toEqual([
      [60, 0, 0.5], [60, 0.5, 0.5], [62, 1, 0.75], [60, 2, 0.5],
      [65, 3, 0.5], [60, 3.5, 0.5], [60, 4, 0.75], [60, 5, 0.5],
      [60, 5.5, 0.25], [60, 6, 0.5], [60, 7, 0.5],
    ]);

    const xml = toMusicXml(raw, ['solo']);
    expect(xml).not.toContain('<time-modification>');
    expect(timed(fromMusicXml(xml).parts[0].notes)).toEqual(timed(projected.parts[0].notes));
    const abc = toAbc(raw, ['solo'], { measureRange: { start: 1, end: 2 } });
    const tracks = abcjs.parseOnly(abc.abc)[0].setUpAudio({ chordsOff: true }).tracks;
    expect(tracks.flat().filter((event) => event.cmd === 'note')
      .map((event) => [event.pitch, event.start * 4, event.duration * 4]))
      .toEqual(timed(projected.parts[0].notes));
    for (const [index, note] of raw.parts[0].notes.entries()) {
      const char = Object.keys(abc.noteMap).find((key) => abc.noteMap[Number(key)].noteId === note.id);
      const segment = abc.noteSegments?.[Number(char)];
      expect(segment?.measured).toEqual({ start: note.start, duration: note.duration });
      expect(segment?.start).toBe(projected.parts[0].notes[index].start);
    }
    expect(raw).toEqual(before);
  });

  it('aligns a corroborated 16th-note phase and keeps clipped same-pitch reattacks', () => {
    const raw = measuredSolo([
      [4, 110 / 480], [4.25, 137 / 480], [4.5, 17 / 480],
      [5, 39 / 480, 67], [5.25, 45 / 480, 67], [5.5, 47 / 480, 67],
      [5.75, 75 / 480, 67], [6, 91 / 480], [6.5, 72 / 480, 67],
      [6.75, 59 / 480], [7, 47 / 480], [7.25, 73 / 480], [7.5, 127 / 480, 67],
    ], -41 / 480);
    const projected = projectMeasuredSoloNotation(raw);
    expect(projected.parts[0].notes).toHaveLength(13);
    expect(timed(projected.parts[0].notes).slice(0, 5)).toEqual([
      [60, 4, 0.25], [60, 4.25, 0.25], [60, 4.5, 0.125], [67, 5, 0.125], [67, 5.25, 0.125],
    ]);
    const xml = toMusicXml(projected, ['solo']);
    expect(xml).not.toContain('<time-modification>');
    expect(timed(fromMusicXml(xml).parts[0].notes)).toEqual(timed(projected.parts[0].notes));
  });

  it('interprets an isolated measured release in the surrounding straight pulse', () => {
    const p = measuredSolo([
      [0, .44], [.5, .44], [1, .4375], [1.5, .44], [2, .44], [2.5, .44],
      [3, .125], [3.25, 1 / 6], [4.5, .44], [5, .44], [6, .44], [7, .44],
    ], 1 / 240);
    const written = projectMeasuredSoloNotation(p).parts[0].notes;
    expect(written[2].duration).toBe(.5); // no invented 64th rest before the next attack
    expect(written[7].duration).toBe(.125);
    expect(written[8].start).toBe(4.5); // the substantial following rest survives
    const articulated = p.parts[0].notes[2];
    articulated.articulation = 'staccato';
    expect(projectMeasuredSoloNotation(p).parts[0].notes[2].duration).toBe(articulated.duration);
  });

  it('preserves written triplets, short rests and a longer phrase break', () => {
    const raw = measuredSolo([
      [0, 0.375], [0.5, 0.5], [1, 1 / 3], [4 / 3, 1 / 3, 62], [5 / 3, 1 / 3, 64],
      [2, 0.375], [2.5, 0.5], [3, 0.5], [5, 0.54], [6, 0.5], [7, 0.5],
    ], 1 / 240);
    const projected = projectMeasuredSoloNotation(raw);
    const notes = projected.parts[0].notes;
    expect(notes.map((note) => note.duration)).toEqual([0.375, 0.5, 1 / 3, 1 / 3, 1 / 3, 0.375, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(notes[1].start - notes[0].start - notes[0].duration).toBe(0.125);
    expect(notes[8].start - notes[7].start - notes[7].duration).toBe(1.5);
    expect(toAbc(projected, ['solo']).abc).toContain('(3:2:3');
    expect(toMusicXml(projected, ['solo']).match(/<actual-notes>3<\/actual-notes>/g)).toHaveLength(3);
  });

  it('distinguishes a lone fine MIDI release from a repeated written figure', () => {
    const raw = measuredSolo([
      [0, .21], [.5, .183], [1, .1875], [1.5, .19],
      [2, .3125], [2.5, .3125], [3, .4375], [3.5, .4375], [4, .21],
    ], 1 / 240);
    const notes = projectMeasuredSoloNotation(raw).parts[0].notes;
    expect(notes[2].duration).toEqual(.25);
    expect(notes.slice(4, 7).map(n => n.duration)).toEqual([.3125, .3125, .4375]);
    expect(notes.map(n => n.start)).toEqual([0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  });

  it('leaves written source, ambiguous attacks and unmeasured performances intact', () => {
    const attacks = Array.from({ length: 12 }, (_, index): TimedNote => [index / 2 + 1, 0.44]);
    const written = measuredSolo(attacks, 1 / 240);
    written.source.kind = 'musicxml';
    expect(projectMeasuredSoloNotation(written)).toBe(written);
    const writtenPhase = measuredSolo(attacks, -1 / 12);
    expect(projectMeasuredSoloNotation(writtenPhase)).toBe(writtenPhase);
    const polyphonic = measuredSolo(attacks, 1 / 240);
    polyphonic.parts[0].notes[1].start = polyphonic.parts[0].notes[0].start + 0.001;
    expect(projectMeasuredSoloNotation(polyphonic)).toBe(polyphonic);
    const unmeasured = measuredSolo(attacks.map(([start, duration], index) => [start + index * 0.027, duration]));
    expect(projectMeasuredSoloNotation(unmeasured)).toBe(unmeasured);
  });
});
