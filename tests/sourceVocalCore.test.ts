import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { createSourceChant } from '../src/lib/sourceChant';
import { transferSourceToSatb } from '../src/lib/sourceTransfer';

const n = (midi: number, start = 0, duration = 4) => ({
  id: `${midi}-${start}`,
  midi,
  start,
  duration,
  velocity: 0.5,
});
function fixture(pitches: number[], lead = 64) {
  const source = createBlankProject();
  source.measures = 4;
  const template = source.parts[0];
  source.parts = [
    { ...template, id: 'upper', notes: pitches.slice(1).map((m) => n(m)) },
    { ...template, id: 'low', notes: [n(pitches[0])] },
  ];
  const scaffold = structuredClone(source);
  scaffold.parts = ['solo', 'voice-s', 'voice-a', 'voice-t', 'voice-b'].map((id) => ({
    ...template,
    id,
    notes: id === 'solo' ? [n(lead)] : [n(60, 8)],
  }));
  return { source, scaffold };
}
const selection = { accompanimentIds: ['upper', 'low'], bassPartId: 'low' };
const spans = [{ first: 1, last: 1 }];
it('follows an independent new left-hand bass after the previous bass releases, in every key', () => {
  for (let shift = 0; shift < 12; shift++) {
    const { source, scaffold } = fixture([44, 54, 58, 62]);
    source.parts[0].notes = [...[54, 58, 62].map(m => n(m + shift, 0, 2)),
      ...[70, 74, 78].map(m => n(m + shift, 2, 2))];
    source.parts[1].notes = [n(44 + shift, 0, 2), n(60 + shift, 2, 2)];
    const r = createSourceChant(scaffold, source, selection, spans, { harmony: 'vocal-core' });
    expect(r.anchors[1].bass).toBe(shift % 12);
    expect(r.bassRoleDecisions).toHaveLength(0);
    // A genuinely continuing pedal is evidence for the opposite decision.
    source.parts[1].notes[0].duration = 4;
    const pedal = createSourceChant(scaffold, source, selection, spans, { harmony: 'vocal-core' });
    expect(pedal.anchors[1].bass).toBe((8 + shift) % 12);
    expect(pedal.bassRoleDecisions).toHaveLength(1);
  }
});
it('reduces source ninth and thirteenth colors only when a supported harmonic core survives', () => {
  for (let shift = 0; shift < 12; shift++)
    for (const [pitches, expected] of [
      [
        [40, 55, 59, 66],
        [4, 7, 11],
      ], // minor third and fifth remain
      [
        [42, 54, 58, 63, 64],
        [6, 10, 4],
      ], // dominant third and seventh remain
      [
        [37, 59, 63, 66],
        [1, 11, 6],
      ], // suspension and seventh remain
      [
        [44, 54, 58, 62],
        [8, 6, 2],
      ], // altered fifth and seventh remain
    ]) {
      const { source, scaffold } = fixture(pitches.map((m) => m + shift));
      const r = createSourceChant(scaffold, source, selection, spans, { harmony: 'vocal-core' });
      expect(
        new Set(
          [r.anchors[0].bass, ...r.anchors[0].upper.map((m) => m % 12)].map((m) => (m - shift + 12) % 12),
        ),
      ).toEqual(new Set(expected));
      expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
      expect(
        r.slices.every((s) => s.voicing.every((m) => pitches.some((p) => (p + shift) % 12 === m % 12))),
      ).toBe(true);
    }
});
it('retains a sixth chord without a seventh and does not invent tones for ambiguous sparse harmony', () => {
  for (const pitches of [
    [45, 60, 64, 66],
    [36, 62, 67],
  ]) {
    const { source, scaffold } = fixture(pitches);
    const r = createSourceChant(scaffold, source, selection, spans, { harmony: 'vocal-core' });
    expect(new Set([r.anchors[0].bass, ...r.anchors[0].upper.map((m) => m % 12)])).toEqual(
      new Set(pitches.map((m) => m % 12)),
    );
  }
});
it('keeps the same source pitches while avoiding an exposed tritone above a sustained Solo', () => {
  const { source, scaffold } = fixture([42, 58, 64], 64);
  const r = transferSourceToSatb(scaffold, source, ['upper', 'low'], spans, {
    connectCommonTones: true,
    melodyPartId: 'solo',
    voiceRanges: [
      [64, 76],
      [57, 69],
      [50, 64],
      [40, 55],
    ],
  });
  expect(r.slices[0].voicing[0] - 64).not.toBe(6);
  expect(new Set(r.slices[0].voicing.map((m) => m % 12))).toEqual(new Set([6, 10, 4]));
  expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
  r.project.parts
    .slice(1)
    .forEach((p, i) => expect(p.notes.filter((n) => n.start >= 8)).toEqual(scaffold.parts[i + 1].notes));
});
it('moves a sustained neighbor away from Solo without deleting the source seventh', () => {
  const { source, scaffold } = fixture([36, 64, 70], 71);
  const r = transferSourceToSatb(scaffold, source, ['upper', 'low'], spans, { melodyPartId: 'solo' });
  expect(r.slices[0].voicing.every((m) => Math.abs(m - 71) !== 1)).toBe(true);
  expect(new Set(r.slices[0].voicing.map((m) => m % 12))).toEqual(new Set([0, 4, 10]));
});
it('does not let previous voicing lock an exposed tritone above the next held melody', () => {
  const { source, scaffold } = fixture([37, 59, 66]);
  source.parts[0].notes = [n(59, 0, 1), n(66, 0, 1), n(58, 1, 1), n(64, 1, 1)];
  source.parts[1].notes = [n(37, 0, 1), n(42, 1, 1)];
  scaffold.parts[0].notes = [n(66, 0, 1), n(67, 1, 0.125), n(66, 1.125, 0.125), n(64, 1.25, 0.75)];
  const r = transferSourceToSatb(scaffold, source, ['upper', 'low'], spans, {
    melodyPartId: 'solo',
    voiceRanges: [
      [64, 76],
      [57, 69],
      [50, 64],
      [40, 55],
    ],
  });
  expect(r.slices[1].voicing[0] - 64).not.toBe(6);
  expect(r.slices[1].voicing[0] - 64).toBeLessThanOrEqual(7);
  expect(new Set(r.slices[1].voicing.map((m) => m % 12))).toEqual(new Set([6, 10, 4]));
});
it('repairs only the selected beats and retains frozen neighboring attacks', () => {
  const { source, scaffold } = fixture([36, 60, 64, 67], 72);
  const originalVoicing = [67, 64, 60, 48];
  scaffold.parts.slice(1).forEach((p, i) => {
    p.notes = [n(originalVoicing[i], 0, 3), n(originalVoicing[i], 3, 1), n(60, 8, 4)];
  });
  const r = transferSourceToSatb(scaffold, source, ['upper', 'low'], spans, {
    melodyPartId: 'solo', connectCommonTones: true, editWindow: { start: 1, end: 3 },
  });
  expect(r.slices.map(s => [s.start, s.duration])).toEqual([[1, 2]]);
  expect(r.slices[0].voicing).toEqual(originalVoicing);
  r.project.parts.slice(1).forEach((p, i) => {
    // The new region can join the incoming held note, but the explicit
    // reattack outside the selection at beat 3 must survive.
    expect(p.notes.find(n => n.start === 3)).toEqual(scaffold.parts[i + 1].notes[1]);
    expect(p.notes.find(n => n.start === 8)).toEqual(scaffold.parts[i + 1].notes[2]);
    expect(p.notes[0].start).toBe(0);
    expect(p.notes[0].midi).toBe(originalVoicing[i]);
  });
  expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
  for (const window of [{ start: -1, end: 2 }, { start: 2, end: 2 }, { start: 1, end: Infinity }]) {
    expect(() => transferSourceToSatb(scaffold, source, ['upper', 'low'], spans, { editWindow: window })).toThrow('Invalid edit window');
  }
});
