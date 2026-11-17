import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { extractSourceHarmony } from '../src/lib/sourceHarmony';
import { createSourceArrangement } from '../src/lib/sourceArrangement';
import { realizeJointVoicing } from '../src/lib/jointVoicing';
import { validateProject } from '../src/lib/music';

const note = (midi: number, start: number, duration: number) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: .6 });
function source() {
  const p = createBlankProject(); p.measures = 4;
  const template = p.parts[0];
  p.parts = ['lead', 'chords', 'bass'].map(id => ({ ...structuredClone(template), id, notes: [], role: 'instrument' as const }));
  p.parts[0].notes = Array.from({ length: 12 }, (_, i) => note([64, 65, 67, 69][i % 4], i, .5));
  p.parts[1].notes = [60, 64, 67].map(m => note(m, 0, 16));
  p.parts[2].notes = [note(36, 0, 16)];
  p.chords = [{ start: 0, duration: 16, symbol: 'C', pitches: [48, 52, 55] }];
  return p;
}
const scaffold = (p: ReturnType<typeof source>) => arrangeV2(p, { preset: 'solo-satb', leadPartId: 'lead', transpose: 0, style: 'pop', difficulty: 'medium', percussion: false });

describe('reliable source harmonic constraints', () => {
  it('keeps source voicing colors without inventing a named chord third', () => {
    const p = source(); p.parts[1].notes = [62, 66, 69, 73].map(m => note(m, 0, 16)); p.parts[2].notes = [note(43, 0, 16)];
    const { guides } = extractSourceHarmony(p, 'lead');
    expect(guides[0].pitches).toEqual([1, 2, 6, 7, 9]);
    expect(guides[0].pitches).not.toContain(11);
    const q = realizeJointVoicing(scaffold(p), { first: 1, last: 2 }, guides).project;
    expect(q.parts.slice(1).flatMap(v => v.notes.filter(n => n.start < 8).map(n => n.midi! % 12)).every(pc => guides[0].pitches.includes(pc))).toBe(true);
  });
  it('uses accompaniment only, including when part names, order or Solo ornaments change', () => {
    const p = source(), before = extractSourceHarmony(p, 'lead');
    p.title = 'Another song'; p.parts[0].notes = [note(61, 0, 16)];
    p.parts.reverse(); p.parts.forEach(v => { v.name = 'unnamed'; });
    expect(extractSourceHarmony(p, 'lead')).toEqual(before);
  });
  it('groups a rolled chord while preserving its bass arrival', () => {
    const p = source(); p.parts[1].notes = [60, 64, 67].map((m, i) => note(m, i / 8, 4 - i / 8));
    const g = extractSourceHarmony(p, 'lead').guides;
    expect(g).toHaveLength(1); expect(g[0].start).toBe(0); expect(g[0].bass).toBe(0);
  });
  it('does not drag a block chord earlier because of a held pickup', () => {
    const p = source(); p.parts[1].notes = [...[60, 64, 67].map(m => note(m, 0, 3)), note(62, 3.875, 2.125), note(65, 4, 2), note(69, 4, 2)];
    p.parts[2].notes = [note(36, 0, 4), note(38, 4, 2)];
    const g = extractSourceHarmony(p, 'lead').guides;
    expect(g.some(x => x.start === 4 && x.bass === 2)).toBe(true);
    expect(g.some(x => x.start > 3 && x.start < 4)).toBe(false);
  });
  it('keeps common-tone harmony across omitted members and a short two-note continuation', () => {
    const p = source();
    p.parts[1].notes = [...[60, 64, 67].map(m => note(m, 0, 2)), ...[64, 67].map(m => note(m, 2, 2)), ...[60, 64, 67].map(m => note(m, 4, 2))];
    const g = extractSourceHarmony(p, 'lead').guides;
    expect(g).toHaveLength(1); expect(g[0].pitches).toEqual([0, 4, 7]);
    expect(g[0].start + g[0].duration).toBe(6);
  });
  it('does not create a chord from an isolated short scale or bridge sustained silence', () => {
    const p = source(); p.parts[1].notes = [...[60, 64, 67].map(m => note(m, 0, 2)), ...[62, 65, 69].map(m => note(m, 8, 2))];
    const g = extractSourceHarmony(p, 'lead').guides;
    expect(g[0].start + g[0].duration).toBe(2);
    p.parts[1].notes = Array.from({ length: 32 }, (_, i) => note(60 + i % 7, i / 4, .25));
    expect(() => extractSourceHarmony(p, 'lead')).toThrow('No sustained chordal accompaniment');
  });
});

describe('source-led arrangement pipeline', () => {
  it('keeps Solo and unrequested music immutable, and realizes monophonic bounded voices', () => {
    const p = source(), old = scaffold(p), saved = structuredClone(old);
    const { project } = createSourceArrangement(old, p, 'lead', [{ first: 1, last: 2 }]);
    expect(old).toEqual(saved); expect(project.parts[0]).toEqual(old.parts[0]);
    expect(validateProject(project)).toEqual([]);
    project.parts.slice(1).forEach((v, i) => {
      const outside = (notes: typeof v.notes) => notes.filter(n => n.start + n.duration > 8).map(({ id, ...n }) => ({ ...n, start: Math.max(8, n.start), duration: n.start + n.duration - Math.max(8, n.start) }));
      expect(outside(v.notes)).toEqual(outside(old.parts[i + 1].notes));
      for (let j = 1; j < v.notes.length; j++) expect(v.notes[j - 1].start + v.notes[j - 1].duration).toBeLessThanOrEqual(v.notes[j].start + 1e-6);
    });
  });
  it('rebuilds from the reliable score even if scaffold chord names and palettes are wrong', () => {
    const p = source(), old = scaffold(p);
    const before = createSourceArrangement(old, p, 'lead', [{ first: 1, last: 2 }]);
    old.chords = [{ start: 0, duration: 16, symbol: 'F#7b9', pitches: [54, 58, 61, 64, 67] }];
    const after = createSourceArrangement(old, p, 'lead', [{ first: 1, last: 2 }]);
    const inside = (q: typeof old) => q.parts.map(v => v.notes.filter(n => n.start < 8));
    expect(inside(after.project)).toEqual(inside(before.project));
  });
});
