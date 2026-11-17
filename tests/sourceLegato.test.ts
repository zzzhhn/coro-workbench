import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { createSourceChant } from '../src/lib/sourceChant';
const n = (midi: number, start: number, duration: number) => ({
  id: `${midi}-${start}`,
  midi,
  start,
  duration,
  velocity: 0.5,
});
function setup(upper: ReturnType<typeof n>[], low: ReturnType<typeof n>[]) {
  const source = createBlankProject();
  source.measures = 4;
  source.tempo = 65;
  const template = source.parts[0];
  source.parts = [
    { ...template, id: 'upper', notes: upper },
    { ...template, id: 'low', notes: low },
  ];
  const scaffold = structuredClone(source);
  scaffold.parts = ['solo', 'voice-s', 'voice-a', 'voice-t', 'voice-b'].map((id) => ({
    ...template,
    id,
    notes: [n(60, 8, 4)],
  }));
  return { source, scaffold };
}
const selection = { accompanimentIds: ['upper', 'low'], bassPartId: 'low' };
it('keeps a low foundation when the left hand leaps into an upper chord register', () => {
  const { source, scaffold } = setup(
    [...[62, 66, 70].map((m) => n(m, 0, 2)), ...[74, 78, 82].map((m) => n(m, 2, 2))],
    [n(44, 0, 2), n(60, 2, 2)],
  );
  const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }], {
    harmony: 'sustained-bass',
  });
  expect(r.anchors.map((a) => a.bass)).toEqual([8, 8]);
  expect(r.anchors[1].sourceUpper).toContain(60);
});
it('does not turn a left-hand upper chord into a new bass inversion', () => {
  const { source, scaffold } = setup(
    [62, 66, 69].map((m) => n(m, 0, 4)),
    [n(43, 0, 1), ...[54, 57, 59, 62].map((m) => n(m, 3, 1))],
  );
  const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }], {
    harmony: 'sustained-bass',
  });
  expect(r.anchors.at(-1)!.bass).toBe(7);
  expect(r.anchors.at(-1)!.sourceUpper).toContain(54);
});
it('preserves a high bass approach confirmed in the low register on the next beat', () => {
  const { source, scaffold } = setup(
    [...[62, 66, 69].map((m) => n(m, 0, 3)), ...[58, 64, 69].map((m) => n(m, 3, 1))],
    [n(43, 0, 3), n(54, 3, 0.5), n(54, 3.5, 0.5), n(42, 4, 2)],
  );
  const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }], {
    harmony: 'sustained-bass',
  });
  expect(r.anchors.at(-1)!.bass).toBe(6);
});
it('still follows a real low-register bass move and preserves Solo/outside', () => {
  const { source, scaffold } = setup(
    [...[60, 64, 67].map((m) => n(m, 0, 2)), ...[62, 66, 69].map((m) => n(m, 2, 2))],
    [n(36, 0, 2), n(43, 2, 2)],
  );
  const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }], {
    harmony: 'sustained-bass',
  });
  expect(r.anchors.map((a) => a.bass)).toEqual([0, 7]);
  expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
  r.project.parts
    .slice(1)
    .forEach((p, i) => expect(p.notes.filter((n) => n.start >= 8)).toEqual(scaffold.parts[i + 1].notes));
});
it('retains the source third and seventh instead of extracting an unrelated upper triad', () => {
  for (let shift = 0; shift < 12; shift++) {
    const { source, scaffold } = setup(
      [64, 67, 70, 74].map((m) => n(m + shift, 0, 4)),
      [n(36 + shift, 0, 4)],
    );
    const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }], {
      harmony: 'sustained-bass',
    });
    expect(new Set(r.anchors[0].upper.map((m) => (m - shift + 120) % 12))).toEqual(new Set([4, 7, 10]));
  }
});
it('keeps the seventh of a source suspended ninth rather than a brighter unrelated triad', () => {
  for (let shift = 0; shift < 12; shift++)
    for (const pitches of [
      [58, 62, 65, 69],
      [70, 62, 65, 69],
    ]) {
      const { source, scaffold } = setup(
        pitches.map((m) => n(m + shift, 0, 4)),
        [n(36 + shift, 0, 4)],
      );
      const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }], {
        harmony: 'sustained-bass',
      });
      expect(new Set(r.anchors[0].upper.map((m) => (m - shift + 120) % 12))).toEqual(new Set([2, 5, 10]));
    }
});
it('joins common tones without inventing periodic repeated attacks in legato backing', () => {
  const { source, scaffold } = setup(
    [...[60, 64, 67].map((m) => n(m, 0, 2)), ...[60, 65, 69].map((m) => n(m, 2, 2))],
    [n(36, 0, 2), n(41, 2, 2)],
  );
  const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }], {
    harmony: 'sustained-bass',
  });
  expect(
    r.project.parts
      .slice(1)
      .some((p) => p.notes.some((n) => n.start === 0 && n.duration === 4 && n.midi! % 12 === 0)),
  ).toBe(true);
  expect(
    r.project.parts
      .slice(1)
      .flatMap((p) => p.notes)
      .some((n) => n.start === 1 || n.start === 3),
  ).toBe(false);
});
