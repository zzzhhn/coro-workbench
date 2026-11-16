import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { interpretSourceHarmony } from '../src/lib/harmonicPlan';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { createChordChant } from '../src/lib/chordChant';

const note = (midi: number, start = 0, duration = 4) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: .6 });
function score(upper: number[], bass: number, solo: number) {
  const p = createBlankProject(); p.measures = 2;
  const part = p.parts[0];
  p.parts = ['solo-source', 'piano', 'bass'].map(id => ({ ...structuredClone(part), id, notes: [] as ReturnType<typeof note>[] }));
  p.parts[0].notes = [note(solo)]; p.parts[1].notes = upper.map(n => note(n)); p.parts[2].notes = [note(bass)];
  p.chords = []; return p;
}
it('separates a major chord root from its inversion bass in all transpositions', () => {
  for (let shift = 0; shift < 12; shift++) {
    const p = score([60, 64, 67].map(n => n + shift), 40 + shift, 67 + shift);
    const g = interpretSourceHarmony(p, 'solo-source').guides[0];
    expect(g.root).toBe(shift); expect(g.bass).toBe((4 + shift) % 12);
    expect(g.quality).toBe(''); expect(g.required).toEqual([0, 4, 7].map(n => (n + shift) % 12));
  }
});
it('does not invent a supported chord from an unexplained cluster', () => {
  const r = interpretSourceHarmony(score([60, 61, 62], 36, 60), 'solo-source');
  expect(r.guides).toHaveLength(0); expect(r.decisions[0].status).toBe('review');
  expect(r.decisions[0].selected).toBeUndefined();
});
it('does not carry a disappeared source tone into a later chord', () => {
  const p = score([60, 64, 67, 71], 36, 67);
  p.parts[1].notes = [...[60, 64, 67, 71].map(n => note(n, 0, 2)), ...[60, 64, 67].map(n => note(n, 2, 2))];
  const r = interpretSourceHarmony(p, 'solo-source');
  expect(r.guides.find(g => g.start === 2)?.pitches).not.toContain(11);
});

it('can retain an omitted third across a same-bass pulse without importing an earlier color', () => {
  const p = score([60, 64, 67, 74], 36, 67);
  p.parts[1].notes = [...[60, 64, 67, 74].map(n => note(n, 0, 1)), ...[60, 67].map(n => note(n, 1, 1)), ...[60, 64, 67].map(n => note(n, 2, 2))];
  const r = interpretSourceHarmony(p, 'solo-source');
  const d = r.decisions.find(d => d.start === 1)!;
  expect(d.selected?.root).toBe(0); expect(d.selected?.inferredCore).toEqual([4]);
  expect(d.selected?.allowed).not.toContain(2); expect(d.status).toBe('review');
});
it('keeps a brief Solo neighbor out of the background harmonic core', () => {
  const p = score([60, 64, 67], 36, 67);
  p.parts[0].notes = [note(67, 0, 1), note(68, 1, .25), note(67, 1.25, 2.75)];
  const r = interpretSourceHarmony(p, 'solo-source');
  expect(r.guides[0].root).toBe(0); expect(r.guides[0].pitches).not.toContain(8);
});
it('realizes an interpreted core as a contract while leaving Solo untouched', () => {
  const p = score([60, 64, 67, 71], 40, 67);
  const old = arrangeV2(p, { preset: 'solo-satb', leadPartId: 'solo-source', transpose: 0, style: 'pop', difficulty: 'medium', percussion: false });
  const r = createChordChant(old, p, 'solo-source', [{ first: 1, last: 1 }], { harmonicPlan: true, register: 'raised' });
  const pitches = r.project.parts.slice(1).map(v => v.notes[0].midi! % 12);
  expect(r.evidence.guides[0].required?.every(pc => pitches.includes(pc))).toBe(true);
  expect(r.project.parts[0]).toEqual(old.parts[0]);
});

it('retains an unresolved span from the prior candidate instead of silencing it', () => {
  const p = score([60, 64, 67], 36, 67);
  p.parts[1].notes.push(...[60, 61, 62].map(n => note(n, 4, 4)));
  p.parts[2].notes.push(note(36, 4, 4));
  const old = arrangeV2(p, { preset: 'solo-satb', leadPartId: 'solo-source', transpose: 0, style: 'pop', difficulty: 'medium', percussion: false });
  old.parts.slice(1).forEach((part, i) => { part.notes = [note([67, 64, 60, 48][i], 4, 4)]; });
  const q = createChordChant(old, p, 'solo-source', [{ first: 1, last: 2 }], { harmonicPlan: true }).project;
  q.parts.slice(1).forEach((part, i) => {
    const kept = part.notes.filter(n => n.start >= 4);
    expect(kept.reduce((sum, n) => sum + n.duration, 0)).toBe(4);
    expect(kept.every(n => n.midi === [67, 64, 60, 48][i])).toBe(true);
  });
});
