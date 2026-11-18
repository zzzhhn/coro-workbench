import { describe, expect, it } from 'vitest';
import { arrangeSourceChant } from '../src/lib/arrangeSourceChant';
import { createBlankProject } from '../src/lib/demo';
import { validateProject } from '../src/lib/music';
import { createSourceChant } from '../src/lib/sourceChant';
import { transferSourceToSatb } from '../src/lib/sourceTransfer';
import type { ArrangementOptions, NoteEvent } from '../src/lib/types';

const note = (midi: number, start: number, duration = 4): NoteEvent => ({
  id: `${midi}-${start}`, midi, start, duration, velocity: .6,
});
const selection = { accompanimentIds: ['upper', 'lower'], bassPartId: 'lower' };
const spans = [{ first: 1, last: 4 }];
const options = { harmony: 'vocal-core' as const };
const pc = (midi: number) => (midi % 12 + 12) % 12;
function fixture(shift = 0) {
  const source = createBlankProject();
  source.measures = 4;
  const template = source.parts[0];
  const chords = [[60, 64, 67], [60, 65, 69], [59, 62, 67], [60, 64, 67]];
  source.parts = [
    { ...structuredClone(template), id: 'upper', program: 0, notes: chords.flatMap((chord, i) => chord.map(m => note(m + shift, i * 4))) },
    { ...structuredClone(template), id: 'lower', program: 0, notes: [36, 41, 43, 40].map((m, i) => note(m + shift, i * 4)) },
  ];
  const scaffold = structuredClone(source);
  scaffold.parts = ['solo', 'voice-s', 'voice-a', 'voice-t', 'voice-b'].map(id => ({
    ...structuredClone(template), id, notes: id === 'solo' ? [72, 74, 71, 72].map((m, i) => note(m + shift, i * 4)) : [],
  }));
  return { source, scaffold };
}
const backing = (result: ReturnType<typeof createSourceChant>) => result.project.parts.slice(1);

describe('opt-in source-chant variants', () => {
  it('preserves the original with absent, zero or unsupported variant values', () => {
    const { source, scaffold } = fixture();
    const baseline = createSourceChant(scaffold, source, selection, spans, options);
    for (const variant of [0, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(createSourceChant(scaffold, source, selection, spans, { ...options, variant })).toEqual(baseline);
    }
  });

  it('repeats each seed and finds distinct close upper allocations without changing evidence, Solo or bass', () => {
    const { source, scaffold } = fixture();
    const original = structuredClone({ source, scaffold });
    const baseline = createSourceChant(scaffold, source, selection, spans, options);
    const signatures = new Set([JSON.stringify(backing(baseline))]);
    for (let variant = 1; variant <= 8; variant++) {
      const result = createSourceChant(scaffold, source, selection, spans, { ...options, variant });
      expect(createSourceChant(scaffold, source, selection, spans, { ...options, variant })).toEqual(result);
      expect(result.project.parts[0]).toEqual(baseline.project.parts[0]);
      expect(result.project.parts[4]).toEqual(baseline.project.parts[4]);
      expect(result.anchors).toEqual(baseline.anchors);
      expect(result.breaths).toEqual(baseline.breaths);
      expect(result.slices.map(({ voicing: _voicing, ...slice }) => slice))
        .toEqual(baseline.slices.map(({ voicing: _voicing, ...slice }) => slice));
      expect(validateProject(result.project)).toEqual([]);
      signatures.add(JSON.stringify(backing(result)));
    }
    expect(signatures.size).toBeGreaterThan(1);
    expect({ source, scaffold }).toEqual(original);
  });

  it('keeps range, order, source pitch classes, inversion bass and least-clash allocation in every key', () => {
    const ranges = [[64, 76], [57, 69], [50, 64], [40, 55]];
    for (let shift = 0; shift < 12; shift++) {
      const { source, scaffold } = fixture(shift);
      const baseline = createSourceChant(scaffold, source, selection, spans, options);
      for (const variant of [1, 2, 5]) {
        const result = createSourceChant(scaffold, source, selection, spans, { ...options, variant });
        result.slices.forEach((slice, i) => {
          expect(new Set(slice.voicing.map(pc))).toEqual(new Set(slice.kept));
          expect(slice.voicing[3]).toBe(baseline.slices[i].voicing[3]);
          slice.voicing.forEach((m, v) => {
            expect(m).toBeGreaterThanOrEqual(ranges[v][0]);
            expect(m).toBeLessThanOrEqual(ranges[v][1]);
            if (v < 3) expect(m).toBeGreaterThanOrEqual(slice.voicing[v + 1]);
            if (v < 2) expect(m - slice.voicing[v + 1]).toBeLessThanOrEqual(12);
          });
          const melody = scaffold.parts[0].notes.find(n => n.start <= slice.start && n.start + n.duration > slice.start)!;
          const clashes = (voicing: number[]) => voicing.slice(0, 3).filter(m => [1, 13].includes(Math.abs(m - melody.midi!))).length;
          expect(clashes(slice.voicing)).toBe(clashes(baseline.slices[i].voicing));
        });
      }
    }
  });

  it('returns the sole safe allocation when the ranges allow no alternative', () => {
    const { source, scaffold } = fixture();
    source.parts[0].notes = [60, 64, 67].map(m => note(m, 0));
    source.parts[1].notes = [note(36, 0)];
    const transferOptions = { voiceRanges: [[67, 67], [64, 64], [60, 60], [48, 48]] as Array<[number, number]> };
    const baseline = transferSourceToSatb(scaffold, source, selection.accompanimentIds, [{ first: 1, last: 1 }], transferOptions);
    expect(transferSourceToSatb(scaffold, source, selection.accompanimentIds, [{ first: 1, last: 1 }], { ...transferOptions, variant: 100 })).toEqual(baseline);
  });

  it('varies independent phrases throughout a song rather than only the final beam state', () => {
    const { source, scaffold } = fixture();
    source.measures = scaffold.measures = 9;
    for (const part of [...source.parts, scaffold.parts[0]]) {
      part.notes = [...part.notes, ...part.notes.map(n => ({ ...n, id: `${n.id}-repeat`, start: n.start + 20 }))];
    }
    const whole = [{ first: 1, last: 9 }];
    const baseline = createSourceChant(scaffold, source, selection, whole, options);
    const changes = Array.from({ length: 8 }, (_, i) => {
      const result = createSourceChant(scaffold, source, selection, whole, { ...options, variant: i + 1 });
      return result.slices.filter((slice, j) => slice.voicing.some((m, v) => m !== baseline.slices[j].voicing[v])).map(slice => slice.start);
    });
    expect(changes.some(starts => starts.some(start => start < 16) && starts.some(start => start >= 20))).toBe(true);
  });

  it('passes the variant through the public arrangement entry point', () => {
    const { source, scaffold } = fixture();
    source.parts.unshift({ ...scaffold.parts[0], id: 'melody', role: 'lead', program: 52 });
    const arrangement: ArrangementOptions = { preset: 'solo-satb', style: 'pop', difficulty: 'medium', percussion: false,
      transpose: 0, leadPartId: 'melody', ...selection };
    const musicalParts = (project: ReturnType<typeof arrangeSourceChant>) => project.parts.map(part => ({ ...part,
      notes: part.notes.map(({ id: _id, ...n }) => n) }));
    const baseline = arrangeSourceChant(source, arrangement);
    expect(musicalParts(arrangeSourceChant(source, { ...arrangement, variant: 0 }))).toEqual(musicalParts(baseline));
    const versions = [1, 2, 3, 4].map(variant => arrangeSourceChant(source, { ...arrangement, variant }));
    expect(versions.some(project => JSON.stringify(musicalParts(project)) !== JSON.stringify(musicalParts(baseline)))).toBe(true);
    versions.forEach(project => {
      expect(musicalParts(project)[0]).toEqual(musicalParts(baseline)[0]);
      expect(project.parts[4]).toEqual(baseline.parts[4]);
      expect(validateProject(project)).toEqual([]);
    });
  });

});
