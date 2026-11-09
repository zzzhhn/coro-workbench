import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { createBlankProject } from '../src/lib/demo';
import { toAbc, toMusicXml } from '../src/lib/music';
import { scoreWindow } from '../src/lib/scoreWindow';

describe('score windows', () => {
  it('groups absolute bars and clamps the first and last pages', () => {
    expect(scoreWindow(74, 0, 4)).toEqual({ start: 1, end: 4 });
    expect(scoreWindow(74, 4, 4)).toEqual({ start: 1, end: 4 });
    expect(scoreWindow(74, 5, 4)).toEqual({ start: 5, end: 8 });
    expect(scoreWindow(74, 74, 4)).toEqual({ start: 73, end: 74 });
    expect(scoreWindow(74, 100, 8)).toEqual({ start: 73, end: 74 });
    expect(scoreWindow(3, 2, 4)).toEqual({ start: 1, end: 3 });
  });

  it('engraves only the requested bars while keeping IDs, absolute times and held notes', () => {
    const project = createBlankProject();
    project.measures = 10;
    project.parts[0].notes = [
      { id: 'held', start: 15, duration: 3, midi: 64, velocity: 0.8, lyric: 'before' },
      { id: 'later', start: 18, duration: 1, midi: 67, velocity: 0.8, lyric: 'inside' },
      { id: 'outside', start: 32, duration: 1, midi: 60, velocity: 0.8 },
    ];
    const fullAbc = toAbc(project);
    const fullXml = toMusicXml(project);
    const result = toAbc(project, undefined, { measureRange: { start: 5, end: 8 }, barsPerSystem: 2 });
    const ids = [...new Set(Object.values(result.noteMap).map(({ noteId }) => noteId))];
    expect(result.systemMeasures).toEqual([5, 7]);
    expect(ids).toEqual(['held', 'later']);
    expect(Object.values(result.noteSegments!)).toContainEqual({
      partId: project.parts[0].id,
      noteIds: ['held'],
      midiPitches: [64],
      start: 16,
      duration: 2,
    });
    expect(result.abc).not.toContain('before');
    expect(result.abc).toContain('inside');
    const voices = abcjs.parseOnly(result.abc)[0].lines.flatMap(
      (line) => line.staff?.flatMap((staff) => staff.voices) ?? [],
    );
    expect(voices.flat().map((element) => element && 'barNumber' in element && element.barNumber)).toContain(6);
    expect(toAbc(project)).toEqual(fullAbc);
    expect(toMusicXml(project)).toBe(fullXml);
    expect(Object.values(fullAbc.noteMap).some(({ noteId }) => noteId === 'outside')).toBe(true);
  });
});
