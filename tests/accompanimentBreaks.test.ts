import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { accompanimentBreaks, planAccompanimentBreaks } from '../src/lib/accompanimentBreaks';
import type { ArrangementPlan, ArrangementSectionPlan } from '../src/lib/types';

function source() {
  const p = createBlankProject();
  p.measures = 14;
  p.timeSignature = [3, 4];
  const note = (start: number, duration: number) => ({
    id: String(start),
    midi: 60,
    velocity: 0.7,
    start,
    duration,
  });
  const example = p.parts[0];
  p.parts = [
    { ...example, id: 'lead', notes: [note(4, 3), note(34.5, 0.5)] },
    { ...example, id: 'keys', role: 'instrument', notes: [note(0, 15), note(18, 24)] },
    { ...example, id: 'drums', role: 'percussion', notes: [note(0, 42)] },
  ];
  return p;
}
describe('source-supported instrumental phrases', () => {
  it('keeps sustained vocals, pickups, intro, outro and unaccompanied bars outside the evidence', () => {
    expect(accompanimentBreaks(source(), 'lead').map(({ first, last }) => [first, last])).toEqual([
      [4, 5],
      [7, 11],
    ]);
    const p = source();
    p.parts.splice(1, 1);
    expect(accompanimentBreaks(p, 'lead')).toEqual([]);
  });
  it('splices one full interval across plan boundaries without dropping or duplicating any bars', () => {
    const sections = [1, 6, 11].map(
      (startBar, i) =>
        ({
          id: 'p' + i,
          kind: 'verse',
          label: 'Verse',
          startBar,
          bars: i === 2 ? 4 : 5,
          energy: 1,
          texture: 'pad',
          bass: 'sustain',
        }) as ArrangementSectionPlan,
    );
    const base: ArrangementPlan = { version: 2, ensemble: 'solo+satb', planner: 'rule', sections };
    const spans = accompanimentBreaks(source(), 'lead');
    const d = {
      first: 7,
      last: 11,
      energy: 3,
      texture: 'bell',
      bass: 'pulse',
      rationale: '分批进入',
    } as const;
    const candidate = planAccompanimentBreaks(base, spans, [d], 'test');
    expect(candidate.sections.map((s) => [s.startBar, s.bars, s.texture])).toEqual([
      [1, 5, 'pad'],
      [6, 1, 'pad'],
      [7, 5, 'bell'],
      [12, 3, 'pad'],
    ]);
    expect(base.sections).toHaveLength(3);
    expect(() => planAccompanimentBreaks(base, spans, [{ ...d, first: 6 }], 'test')).toThrow();
    expect(() => planAccompanimentBreaks(base, spans, [d, d], 'test')).toThrow();
  });
});

it('recognizes a transposed phrase with matching timing but distinguishes its rhythmic variation', async () => {
  const { describeScore } = await import('../src/lib/arrangementBrief');
  const p = source();
  p.parts[0].notes = [0, 6, 12].flatMap((start, i) =>
    [0, 2, 4].map((pitch, j) => ({
      id: i + '-' + j,
      midi: 60 + pitch + i,
      start: start + j * 0.5,
      duration: i === 2 && j === 1 ? 0.25 : 0.5,
      velocity: 0.7,
    })),
  );
  const brief = describeScore(p, 'lead');
  expect(brief.matchingPhrases).toEqual([[1, 2]]);
  expect(brief.phrases[0]).toMatchObject({
    firstBar: 1,
    lastBar: 1,
    firstPitch: 60,
    lastPitch: 64,
    lyricAttacks: 0,
  });
});

it('accepts different whole-song forms and rejects holes, overlaps and unsupported creative choices', async () => {
  const { wholeSongPlan } = await import('../src/lib/auditionPlan');
  const s = {
    id: 'x',
    startBar: 1,
    bars: 4,
    kind: 'intro',
    label: 'Opening',
    energy: 1,
    texture: 'bell',
    bass: 'pulse',
    rationale: 'Introduce the pulse.',
  } as const;
  const plan = wholeSongPlan(8, [s, { ...s, startBar: 5, kind: 'verse' }], 'local planner');
  expect(plan.sections.map((s) => s.id)).toEqual(['section-1', 'section-5']);
  for (const startBar of [4, 6])
    expect(() => wholeSongPlan(8, [s, { ...s, startBar }], 'local planner')).toThrow();
  expect(() => wholeSongPlan(5, [s], 'local planner')).toThrow();
  expect(() => wholeSongPlan(4, [{ ...s, rationale: '' }], 'local planner')).toThrow();
});
