import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { reviewIssues } from '../src/lib/noteInput';
import { attacksBetween, makeTuplet, reflowOnsets, removeTuplet } from '../src/lib/tuplets';
import type { NoteEvent, ScoreProject } from '../src/lib/types';

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
const project = (notes: NoteEvent[]): ScoreProject => {
  const p = createBlankProject();
  p.parts[0].notes = notes;
  return p;
};
const sel = (ids: string[]) => ids.map((noteId) => ({ partId: 'piano', noteId }));
const shape = (p: ScoreProject) => p.parts[0].notes.map((note) => [note.id, note.start, note.duration]);
const T = Math.round((1 / 3) * 960) / 960;

describe('tuplet grouping', () => {
  it('three eighths misread at 0.5 become a triplet in one beat; the next note keeps its place', () => {
    // OMR footprint: the triplet bracket was missed, so c starts on beat 1 and sounds into d.
    const p = project([n('a', 0, 0.5, 60), n('b', 0.5, 0.5, 62), n('c', 1, 0.5, 64), n('d', 1.25, 1, 65)]);
    const { project: out, changed, warnings } = makeTuplet(p, sel(['a', 'b', 'c']));
    expect(shape(out)).toEqual([
      ['a', 0, T],
      ['b', T, T],
      ['c', 2 * T, T],
      ['d', 1.25, 1],
    ]);
    expect(changed).toBe(3);
    expect(warnings).toEqual([]);
    expect(reviewIssues(out).filter((issue) => issue.kind === 'overlap')).toEqual([]);
    expect(reviewIssues(p).filter((issue) => issue.kind === 'overlap').length).toBeGreaterThan(0);
  });
  it('engraves a bracketed triplet and survives MusicXML round trip as time-modification', () => {
    const out = makeTuplet(
      project([n('a', 0, 0.5, 60), n('b', 0.5, 0.5, 62), n('c', 1, 0.5, 64)]),
      sel(['a', 'b', 'c']),
    ).project;
    expect(toAbc(out).abc).toContain('(3:2:3');
    const xml = toMusicXml(out);
    expect(xml).toContain('<actual-notes>3</actual-notes><normal-notes>2</normal-notes>');
    const back = fromMusicXml(xml).parts[0].notes.filter((note) => note.midi !== null);
    expect(back.map((note) => [note.start, note.duration])).toEqual([
      [0, T],
      [T, T],
      [2 * T, T],
    ]);
    expect(validateProject(out)).toEqual([]);
  });
  it('chord tones move with their attack; a whole chord counts as one attack', () => {
    const p = project([n('a', 0, 0.5, 60), n('a2', 0, 0.5, 64), n('b', 0.5, 0.5, 62), n('c', 1, 0.5, 64)]);
    const out = makeTuplet(p, sel(['a', 'b', 'c'])).project;
    expect(out.parts[0].notes.find((note) => note.id === 'a2')!.duration).toBe(T);
  });
  it('quarter-note triplet spans two beats; 2:3 duplet spreads two notes over three eighths', () => {
    const q = makeTuplet(
      project([n('a', 0, 1, 60), n('b', 1, 1, 62), n('c', 2, 1, 64)]),
      sel(['a', 'b', 'c']),
    ).project;
    expect(q.parts[0].notes.map((note) => note.start)).toEqual([
      0,
      Math.round((2 / 3) * 960) / 960,
      Math.round((4 / 3) * 960) / 960,
    ]);
    const d = makeTuplet(project([n('a', 0, 0.5, 60), n('b', 0.5, 0.5, 62)]), sel(['a', 'b']), {
      actual: 2,
      normal: 3,
    }).project;
    expect(d.parts[0].notes.map((note) => [note.start, note.duration])).toEqual([
      [0, 0.75],
      [0.75, 0.75],
    ]);
  });
  it('reports a wrong count, unselected notes inside the span, and refuses mixed lanes', () => {
    const p = project([n('a', 0, 0.5, 60), n('b', 0.5, 0.5, 62), n('x', 0.5, 0.25, 67, { voice: '2' })]);
    const result = makeTuplet(p, sel(['a', 'b']));
    expect(result.warnings[0]).toContain('需要 3 个');
    expect(() => makeTuplet(p, sel(['a', 'x']))).toThrow('不同谱表或声部');
    const crowd = makeTuplet(
      project([n('a', 0, 0.5, 60), n('b', 0.5, 0.5, 62), n('c', 1, 0.5, 64), n('u', 0.75, 0.25, 70)]),
      sel(['a', 'b', 'c']),
    );
    expect(crowd.warnings.join()).toContain('1 个未选中的音符');
  });
  it('remove tuplet restores plain values end to end', () => {
    const tuplet = makeTuplet(
      project([n('a', 0, 0.5, 60), n('b', 0.5, 0.5, 62), n('c', 1, 0.5, 64)]),
      sel(['a', 'b', 'c']),
    ).project;
    expect(shape(removeTuplet(tuplet, sel(['a', 'b', 'c'])).project)).toEqual([
      ['a', 0, 0.5],
      ['b', 0.5, 0.5],
      ['c', 1, 0.5],
    ]);
  });
});

describe('onset re-flow', () => {
  it('one misread value shifts the run; re-flow lays the run end to end from the first attack', () => {
    // OMR read the 2nd note as a quarter (should be eighth) and drifted the rest by +0.5.
    const p = project([n('a', 0, 0.5, 60), n('b', 0.5, 0.5, 62), n('c', 1.5, 0.5, 64), n('d', 2.5, 0.5, 65)]);
    const out = reflowOnsets(p, sel(['a', 'b', 'c', 'd']));
    expect(shape(out.project)).toEqual([
      ['a', 0, 0.5],
      ['b', 0.5, 0.5],
      ['c', 1, 0.5],
      ['d', 1.5, 0.5],
    ]);
    expect(out.changed).toBe(2);
  });
  it('click-first/click-last picks every attack between them in that lane', () => {
    const p = project([
      n('a', 0, 1, 60),
      n('a2', 0, 1, 64),
      n('b', 1, 1, 62),
      n('x', 1, 2, 48, { staff: 2 }),
      n('c', 2, 1, 64),
    ]);
    p.parts[0].staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    expect(
      attacksBetween(p, { partId: 'piano', noteId: 'c' }, { partId: 'piano', noteId: 'a' }).map(
        (s) => s.noteId,
      ),
    ).toEqual(['a', 'b', 'c']);
  });
});
