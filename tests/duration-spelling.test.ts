import abcjs from 'abcjs';
import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import type { NoteEvent, ScoreProject } from '../src/lib/types';

const note = (id: string, midi: number, start: number, duration: number): NoteEvent => ({
  id, midi, start, duration, velocity: 0.8,
});

function score(notes: NoteEvent[], measures = 1, timeSignature: ScoreProject['timeSignature'] = [4, 4]) {
  const project = createBlankProject();
  project.timeSignature = timeSignature;
  project.measures = measures;
  project.parts[0].notes = notes;
  expect(validateProject(project)).toEqual([]);
  return project;
}

function expectTiming(project: ScoreProject, abc: string, xml: string) {
  const toTicks = (beats: number) => Math.round(beats * 960);
  const noteRows = (notes: NoteEvent[]) => notes.filter((note) => note.midi !== null)
    .map(({ midi, start, duration }) => [midi, toTicks(start), toTicks(duration)]);
  const expected = noteRows(project.parts[0].notes);
  const tune = abcjs.parseOnly(abc)[0];
  expect(tune.warnings ?? []).toEqual([]);
  const played = tune.setUpAudio({ chordsOff: true }).tracks.flat()
    .filter((event) => event.cmd === 'note')
    .map(({ pitch, start, duration }) => [pitch, toTicks(start * 4), toTicks(duration * 4)]);
  expect(played).toEqual(expected);
  expect(noteRows(fromMusicXml(xml).parts[0].notes)).toEqual(expected);
}

describe('written duration spelling', () => {
  it('writes double-dotted notes as one glyph in ABC and MusicXML', () => {
    const project = score([note('held', 60, 0, 3.5), note('next', 62, 3.5, 0.5)]);
    const { abc, noteSegments } = toAbc(project);
    const xml = toMusicXml(project);
    const held = [...new Set(Object.values(noteSegments ?? {}))].filter((segment) => segment.noteIds.includes('held'));
    expect(held.map((segment) => segment.duration)).toEqual([3.5]);
    expect(abc).toContain('C7');
    expect(xml).toContain('<type>half</type><dot/><dot/>');
    expect(xml).not.toContain('<tie ');
    expectTiming(project, abc, xml);
  });

  it('groups audible triplet notes and their printed rests together', () => {
    const project = score([
      note('a', 60, 0, 1 / 3),
      note('b', 62, 2 / 3, 1 / 3),
      note('c', 64, 4 / 3, 1 / 3),
      note('d', 65, 2, 2),
    ]);
    const abc = toAbc(project).abc;
    const xml = toMusicXml(project);
    expect(abc.match(/\(3:2:3/g)).toHaveLength(2);
    expect(abc).not.toContain('(3:2:1');
    expect(xml.match(/<tuplet type="start" bracket="yes"\/>/g)).toHaveLength(2);
    expect(xml.match(/<tuplet type="stop"\/>/g)).toHaveLength(2);
    expect(xml.match(/<rest\/><duration>320<\/duration>/g)).toHaveLength(3);
    expectTiming(project, abc, xml);
  });

  it('spells a compound duration with an ordinary eighth and a true eighth triplet', () => {
    const project = score([note('held', 60, 0, 5 / 6), note('next', 62, 1, 1.25)]);
    const { abc, noteSegments } = toAbc(project);
    const xml = toMusicXml(project);
    const held = [...new Set(Object.values(noteSegments ?? {}))].filter((segment) => segment.noteIds.includes('held'));
    expect(held.map((segment) => Math.round(segment.duration * 960))).toEqual([480, 320]);
    expect(abc).toContain('(3:2:2');
    expect(abc).not.toContain('(3:1:1');
    expect(xml).not.toContain('<normal-notes>1</normal-notes>');
    expectTiming(project, abc, xml);
  });

  it('finishes a mixed-length triplet on the beat and keeps the following bar in time', () => {
    const project = score([
      note('a', 58, 0, 2 / 3),
      note('held', 58, 2 / 3, 5 / 6),
      note('b', 58, 2, 2 / 3),
      note('c', 58, 8 / 3, 2 / 3),
      note('next', 62, 4, 1),
    ], 2);
    const { abc, noteSegments } = toAbc(project);
    const xml = toMusicXml(project);
    const held = [...new Set(Object.values(noteSegments ?? {}))].filter((segment) => segment.noteIds.includes('held'));
    expect(held.map((segment) => Math.round(segment.duration * 960))).toEqual([320, 480]);
    expect(abc.match(/\(3:2:2/g)).toHaveLength(1);
    expect(abc.match(/\(3:2:3/g)).toHaveLength(1);
    expect(abc).not.toContain('(3:2:1');
    expectTiming(project, abc, xml);
  });

  it('keeps a genuinely isolated triplet from changing later ABC playback', () => {
    const project = score([note('triplet', 60, 0, 2 / 3), note('next', 62, 2 / 3, 1), note('last', 64, 2, 2)]);
    const abc = toAbc(project).abc;
    const xml = toMusicXml(project);
    expect(abc).toMatch(/\(3:2:2C-C/);
    expect(abc).not.toContain('(3:2:1');
    expectTiming(project, abc, xml);
  });

  it('shows the beat and middle of a 4/4 bar after a weak-position silence begins', () => {
    const project = score([note('short', 60, 0, 0.5), note('next', 62, 4, 1)], 2);
    const abc = toAbc(project).abc;
    const xml = toMusicXml(project);
    expect(abc).toMatch(/C z z2 z4\s+\|/);
    expect(xml).not.toContain('<dot/>');
    expectTiming(project, abc, xml);
  });

  it('writes a single whole-measure rest in 5/4 and preserves the next downbeat', () => {
    const project = score([note('next', 60, 5, 1)], 2, [5, 4]);
    const abc = toAbc(project).abc;
    const xml = toMusicXml(project);
    expect(abc).toMatch(/\[V:[^\]]+\] z10\s+\|/);
    expect(xml).toMatch(/<note><rest measure="yes"\/><duration>4800<\/duration><voice>[^<]+<\/voice><\/note>/);
    expectTiming(project, abc, xml);
  });
});
