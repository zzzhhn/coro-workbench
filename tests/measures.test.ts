import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateArrangementVersion } from '../src/lib/arrangementVersions';
import { createBlankProject, createDemoProject } from '../src/lib/demo';
import { toAbc, toMusicXml, fromMusicXml, validateProject } from '../src/lib/music';
import { deleteMeasures, insertMeasures } from '../src/lib/measures';
import { projectFromOmr } from '../src/lib/import';
import { omrMeasureOf, regionFor, scoreMeasureOf } from '../src/lib/sourceMap';
import { reviewIssues } from '../src/lib/noteInput';
import type { ArrangementOptions, MeasureLock, NoteEvent, OmrJob, OmrReview, ScoreProject } from '../src/lib/types';

const n = (
  id: string,
  start: number,
  duration: number,
  midi: number | null,
  extra: Partial<NoteEvent> = {},
): NoteEvent => ({
  id,
  start,
  duration,
  midi,
  velocity: 0.8,
  ...extra,
});
function score(): ScoreProject {
  const p = createBlankProject();
  p.measures = 3;
  p.parts[0].notes = [
    n('a', 0, 4, 60, { lyric: 'la' }),
    n('held', 6, 4, 62, { lyric: 'li' }),
    n('c', 10, 2, 64),
  ];
  p.parts[0].pedals = [{ start: 2, end: 9 }];
  p.chords = [
    { start: 0, duration: 4, symbol: 'C', pitches: [60, 64, 67] },
    { start: 4, duration: 8, symbol: 'G', pitches: [55, 59, 62] },
  ];
  return p;
}
const shape = (p: ScoreProject) =>
  p.parts[0].notes.map((note) => [note.start, note.duration, note.midi, note.lyric ?? '']);

describe('insert measures', () => {
  it('shifts everything after the point; a held note is split with the lyric on its attack', () => {
    const { project, warnings } = insertMeasures(score(), 3);
    expect(project.measures).toBe(4);
    expect(shape(project)).toEqual([
      [0, 4, 60, 'la'],
      [6, 2, 62, 'li'],
      [12, 2, 62, ''],
      [14, 2, 64, ''],
    ]);
    // The tail is the same printed note: same pitch, no lyric, same provenance.
    const [head, tail] = project.parts[0].notes.filter((note) => note.midi === 62);
    expect(tail.sourceRef).toBe(head.sourceRef);
    expect(project.chords.map((c) => [c.symbol, c.start, c.duration])).toEqual([
      ['C', 0, 4],
      ['G', 4, 4],
      ['G', 12, 4],
    ]);
    expect(project.parts[0].pedals).toEqual([{ start: 2, end: 13 }]); // pedal 2-9 spans beat 8
    expect(warnings.join()).toContain('1 个跨插入点的长音');
    expect(validateProject(project)).toEqual([]);
    expect(() => toAbc(project)).not.toThrow();
  });
  it('appending at the end only adds empty bars; several bars at once', () => {
    const { project } = insertMeasures(score(), 4, 2);
    expect(project.measures).toBe(5);
    expect(shape(project)).toEqual(shape(score()));
    expect(() => insertMeasures(score(), 6)).toThrow('插入位置无效');
  });
  it('a pedal spanning the point stretches over the new bar', () => {
    const { project } = insertMeasures(score(), 2);
    expect(project.parts[0].pedals).toEqual([{ start: 2, end: 13 }]);
  });
});

describe('delete measures', () => {
  it('removes the bars in every part, pulls later bars earlier, cuts notes held into them', () => {
    const { project, warnings } = deleteMeasures(score(), 2);
    expect(project.measures).toBe(2);
    // "held" starts in bar 2 and rings into bar 3: it goes with its bar. "c" moves to beat 6.
    expect(shape(project)).toEqual([
      [0, 4, 60, 'la'],
      [6, 2, 64, ''],
    ]);
    expect(project.chords.map((c) => [c.symbol, c.start, c.duration])).toEqual([['C', 0, 4]]);
    expect(project.parts[0].pedals).toEqual([{ start: 2, end: 5 }]);
    expect(warnings.join()).toContain('1 个从被删小节延续到后面的长音一并删除');
  });
  it('a note held into the deleted range is shortened at the cut', () => {
    const p = score();
    p.parts[0].notes = [n('long', 2, 4, 60), n('after', 8, 4, 62)];
    const { project, warnings } = deleteMeasures(p, 2);
    expect(shape(project)).toEqual([
      [2, 2, 60, ''],
      [4, 4, 62, ''],
    ]);
    expect(warnings.join()).toContain('截短');
  });
  it('refuses to delete every bar and out-of-range bars', () => {
    expect(() => deleteMeasures(score(), 1, 3)).toThrow('至少保留一个小节');
    expect(() => deleteMeasures(score(), 4)).toThrow('有效小节');
  });
  it('insert then delete the same bar restores the score (round trip)', () => {
    const original = createDemoProject();
    const inserted = insertMeasures(original, 5, 2).project;
    const back = deleteMeasures(inserted, 5, 6).project;
    const simple = (p: ScoreProject) =>
      p.parts.map((part) => part.notes.map((note) => [note.start, note.duration, note.midi]).sort());
    // Only held-across notes are split on insert; the demo has none at bar 5, so the round trip is exact.
    expect(simple(back)).toEqual(simple(original));
    expect(back.measures).toBe(original.measures);
    expect(fromMusicXml(toMusicXml(back)).parts[0].notes.length).toBeGreaterThan(0);
  });
});

describe('measure edits keep locks with the surviving music', () => {
  const options: ArrangementOptions = {
    preset: 'solo-satb', style: 'pop', difficulty: 'medium', transpose: 0, percussion: false,
  };

  function lockedScore(locks: MeasureLock[] = [
    { first: 2, last: 4 }, { first: 5, last: 6 }, { first: 8, last: 8 },
  ]) {
    const project = score();
    project.measures = 8;
    project.arrangement = {
      options,
      report: { changes: [], warnings: [], ranges: [] },
      locks,
    };
    return project;
  }

  const locksOf = (project: ScoreProject) => project.arrangement?.locks?.map(({ first, last }) => [first, last]);

  it.each([
    { bar: 2, expected: [[4, 6], [7, 8], [10, 10]] },
    { bar: 4, expected: [[2, 3], [6, 6], [7, 8], [10, 10]] },
    { bar: 5, expected: [[2, 4], [7, 8], [10, 10]] },
    { bar: 9, expected: [[2, 4], [5, 6], [8, 8]] },
  ])('maps insertion before bar $bar and leaves the two empty bars unlocked', ({ bar, expected }) => {
    const original = lockedScore();
    const { project } = insertMeasures(original, bar, 2);
    expect(locksOf(project)).toEqual(expected);
    expect(validateProject(project)).toEqual([]);
    // Whole-project history retains the original locks for undo.
    expect(locksOf(original)).toEqual([[2, 4], [5, 6], [8, 8]]);
  });

  it.each([
    { from: 1, to: 1, expected: [[1, 3], [4, 5], [7, 7]] },
    { from: 2, to: 3, expected: [[2, 2], [3, 4], [6, 6]] },
    { from: 3, to: 3, expected: [[2, 3], [4, 5], [7, 7]] },
    { from: 4, to: 5, expected: [[2, 3], [4, 4], [6, 6]] },
    { from: 2, to: 7, expected: [[2, 2]] },
    { from: 8, to: 8, expected: [[2, 4], [5, 6]] },
  ])('keeps the surviving lock bars after deleting $from through $to', ({ from, to, expected }) => {
    const { project } = deleteMeasures(lockedScore(), from, to);
    expect(locksOf(project)).toEqual(expected);
    expect(validateProject(project)).toEqual([]);
  });

  it('keeps tied notes and chords in a surviving locked bar when deleting their attack or middle', () => {
    const original = lockedScore([{ first: 3, last: 3 }]);
    const attack = n('tail', 6, 3, 62, { lyric: 'li', sourceRef: 'held-attack' });
    const through = n('through', 3, 7, 64, { lyric: 'la' });
    const cut = n('cut', 2, 6, 60);
    original.parts[0].notes = [cut, through, attack];
    const throughChord = { start: 3, duration: 7, symbol: 'C', pitches: [60, 64, 67] };
    const tailChord = { start: 6, duration: 3, symbol: 'G', pitches: [55, 59, 62] };
    original.chords = [throughChord, tailChord];

    const { project, warnings } = deleteMeasures(original, 2);
    expect(locksOf(project)).toEqual([[2, 2]]);
    expect(project.parts[0].notes).toEqual([
      { ...cut, duration: 2 }, { ...through, duration: 3 },
      n('tail', 4, 1, 62, { sourceRef: 'held-attack' }),
    ]);
    expect(project.chords).toEqual([
      { ...throughChord, duration: 3 }, { ...tailChord, start: 4, duration: 1 },
    ]);
    expect(warnings.join()).toContain('2 个跨越被删小节的长音保留了延入锁定小节的部分');
    expect(validateProject(project)).toEqual([]);
  });

  it('preserves measured attacks inside a moved lock without rounding them to the edit grid', () => {
    const original = lockedScore([{ first: 2, last: 2 }]);
    original.parts[0].notes = [n('measured', 4.1234, 0.5678, 60)];
    original.chords = [{ start: 4.1234, duration: 0.5678, symbol: 'C', pitches: [60, 64, 67] }];
    const inserted = insertMeasures(original, 1).project;
    expect(inserted.parts[0].notes[0].start).toBeCloseTo(8.1234, 10);
    expect(inserted.chords[0].start).toBeCloseTo(8.1234, 10);
    const edited = deleteMeasures(inserted, 1).project;
    expect(locksOf(edited)).toEqual([[2, 2]]);
    expect(edited.parts[0].notes[0].start).toBeCloseTo(4.1234, 10);
    expect(edited.chords[0].start).toBeCloseTo(4.1234, 10);
  });

  it('regenerates around both locked halves of a tie split by an inserted bar', () => {
    const source = createDemoProject();
    const approved = generateArrangementVersion(source, options).project;
    approved.arrangement!.locks = [{ first: 4, last: 6 }];
    approved.parts[1].notes = [n('accepted', 14, 4, 64, { lyric: 'la' })];
    approved.chords = [{ start: 14, duration: 4, symbol: 'C', pitches: [60, 64, 67] }];

    const edited = insertMeasures(approved, 5).project;
    const regenerated = generateArrangementVersion(insertMeasures(source, 5).project, options, edited).project;
    expect(locksOf(regenerated)).toEqual([[4, 4], [6, 7]]);
    const locked = (event: { start: number; duration: number }) =>
      (event.start < 16 && event.start + event.duration > 12) ||
      (event.start < 28 && event.start + event.duration > 20);
    expect(regenerated.parts[1].notes.filter(locked)).toEqual(edited.parts[1].notes);
    expect(regenerated.chords.filter(locked)).toEqual(edited.chords);
  });
});

describe('measure edits keep the source-image review aligned', () => {
  it('after inserting a bar before bar 5, OMR bar 5 maps to score bar 6 and its issue follows', () => {
    const dir = 'tests/fixtures/omr-review/airds-air';
    const job: OmrJob = {
      id: 'a'.repeat(32),
      status: 'complete',
      progress: 100,
      stage: 'complete',
      message: '',
      musicxml: readFileSync(`${dir}/homr.musicxml`, 'utf8'),
      source: { filename: 'airds-air.png', engine: 'homr' },
      pageUrls: [`/api/omr/jobs/${'a'.repeat(32)}/pages/1`],
      review: JSON.parse(readFileSync(`${dir}/review.json`, 'utf8')) as OmrReview,
    };
    // Insert where a note is held across the barline, so a tail shares its attack's sourceRef.
    const imported = projectFromOmr(job);
    const held = imported.parts[0].notes.find((note) => note.start < 16 && note.start + note.duration > 16);
    if (held) expect(held.sourceRef).toBeTruthy();
    const project = insertMeasures(imported, 5).project;
    // Every score bar after the insertion maps back to OMR bar = score bar - 1.
    for (let bar = 6; bar <= 10; bar++) expect(omrMeasureOf(project, 0, bar)).toBe(bar - 1);
    expect(scoreMeasureOf(project, 0, 5)).toBe(6);
    expect(omrMeasureOf(project, 0, 6)).toBe(5);
    expect(regionFor(project, omrMeasureOf(project, 0, 6), 0)?.measure).toBe(5);
    const underfull = reviewIssues(project)
      .filter((issue) => issue.kind === 'measure-underfull')
      .map((issue) => issue.measure);
    expect(underfull).toEqual([1, 10, 11, 19]);
  });
});
