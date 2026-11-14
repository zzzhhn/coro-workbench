import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBlankProject, createDemoProject } from '../src/lib/demo';
import { toAbc, toMusicXml, fromMusicXml, validateProject } from '../src/lib/music';
import { deleteMeasures, insertMeasures } from '../src/lib/measures';
import { projectFromOmr } from '../src/lib/import';
import { omrMeasureOf, regionFor, scoreMeasureOf } from '../src/lib/sourceMap';
import { reviewIssues } from '../src/lib/noteInput';
import type { NoteEvent, OmrJob, OmrReview, ScoreProject } from '../src/lib/types';

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
