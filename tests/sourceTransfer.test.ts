import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { transferSourceToSatb } from '../src/lib/sourceTransfer';
const n = (midi: number, start = 0, duration = 4) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: .6 });
function fixture() {
  const source = createBlankProject(); source.measures = 4;
  source.parts[0].notes = [n(48), n(60), n(64), n(67)];
  const scaffold = structuredClone(source);
  scaffold.parts = ['solo', 'voice-s', 'voice-a', 'voice-t', 'voice-b'].map(id => ({ ...structuredClone(source.parts[0]), id }));
  return { source, scaffold };
}
it('retains every source pitch class and actual inversion bass in all keys', () => {
  for (let shift = 0; shift < 12; shift++) {
    const { source, scaffold } = fixture(); source.parts[0].notes = [40, 60, 64, 67, 71].map(x => n(x + shift));
    const r = transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }]);
    const row = r.slices[0];
    expect(new Set(row.voicing.map(x => x % 12))).toEqual(new Set(source.parts[0].notes.map(x => x.midi! % 12)));
    expect(row.voicing[3] % 12).toBe((40 + shift) % 12);
    for (const slice of r.slices) {
      const actual = r.project.parts.slice(1).map(p => p.notes.find(n => n.start <= slice.start + 1e-6 && n.start + n.duration >= slice.start + slice.duration - 1e-6)!.midi);
      expect(actual).toEqual(slice.voicing);
    }
    expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
  }
});
it('never carries released source colors forward and preserves reattacks', () => {
  const { source, scaffold } = fixture(); source.parts[0].notes = [n(48), n(64), n(67), n(71, 0, 2), n(67, 2, 2)];
  const r = transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }]);
  expect(r.slices.find(s => s.start === 2)!.voicing.map(x => x % 12)).not.toContain(11);
  expect(r.project.parts.slice(1).some(p => p.notes.some(x => x.start === 2 && x.midi! % 12 === 7))).toBe(true);
});
it('reports the capacity reduction without inventing or renaming a chord', () => {
  const { source, scaffold } = fixture(); source.parts[0].notes = [48, 60, 62, 64, 67, 71].map(x => n(x));
  const row = transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }]).slices[0];
  expect(row.omitted).toHaveLength(1); expect(row.voicing.every(x => row.sourcePitches.includes(x % 12))).toBe(true);
});
it('preserves silence, unselected spans, and the source object', () => {
  const { source, scaffold } = fixture(); source.parts[0].notes = [n(48, 0, 1), n(64, 0, 1), n(67, 0, 1), n(48, 2, 1)];
  scaffold.parts.forEach(p => p.notes.push(n(60, 8, 4))); const copy = structuredClone(source);
  const p = transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }]).project;
  expect(source).toEqual(copy);
  p.parts.slice(1).forEach((part, i) => { expect(part.notes.some(x => x.start < 2 && x.start + x.duration > 1)).toBe(false); expect(part.notes.filter(x => x.start >= 4)).toEqual(scaffold.parts[i + 1].notes.filter(x => x.start >= 4)); });
});
it('collapses only overlapping rolled attacks when explicitly requested', () => {
  const { source, scaffold } = fixture(); source.parts[0].notes = [n(60, 0, 1), n(64, .09375, .89355), n(67, .1875, .833333)];
  const literal = transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }]);
  expect(literal.rolls).toHaveLength(0);
  const r = transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }], { collapseRolledChords: true });
  expect(r.rolls).toHaveLength(1); expect(r.slices).toHaveLength(1); expect(r.slices[0].duration).toBe(1);
});
it('keeps performed grace notes by default and logs optional backing reduction', () => {
  const { source, scaffold } = fixture(); source.parts[0].notes = [n(72, 0, .059082), ...[52,55,59].map(x => n(x, .0625, .890625))];
  const copy = structuredClone(source);
  expect(transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }]).ornaments).toHaveLength(0);
  const r = transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }], { reducePerformedGraceNotes: true });
  expect(r.ornaments).toHaveLength(1); expect(r.slices).toHaveLength(1);
  expect(r.slices[0].sourcePitches.sort()).toEqual([4,7,11].sort()); expect(r.slices[0].duration).toBe(1);
  expect(source).toEqual(copy);
  source.parts[0].notes = [n(72, 0, .0625),n(74,.0625,.0625),n(76,.125,.0625)];
  expect(transferSourceToSatb(scaffold, source, [source.parts[0].id], [{ first: 1, last: 1 }], { reducePerformedGraceNotes: true }).ornaments).toHaveLength(0);
});
