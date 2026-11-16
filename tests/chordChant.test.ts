import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { createChordChant } from '../src/lib/chordChant';

const note = (midi: number, start: number, duration: number) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: .6 });
function fixture() {
  const p = createBlankProject(); p.measures = 8;
  const template = p.parts[0];
  p.parts = ['lead', 'chords', 'bass'].map(id => ({ ...structuredClone(template), id, role: 'instrument' as const, notes: [] as ReturnType<typeof note>[] }));
  for (const offset of [0, 16]) {
    p.parts[0].notes.push(...Array.from({ length: 16 }, (_, i) => note([64, 67][i % 2], offset + i / 2, .5)));
    p.parts[1].notes.push(...[60, 64, 67].map(m => note(m, offset, 4)), ...[60, 64, 69].map(m => note(m, offset + 4, 4)));
    p.parts[2].notes.push(note(36, offset, 4), note(33, offset + 4, 4));
  }
  p.chords = [{ start: 0, duration: 32, symbol: 'C', pitches: [48, 52, 55] }];
  const old = arrangeV2(p, { preset: 'solo-satb', leadPartId: 'lead', transpose: 0, style: 'pop', difficulty: 'medium', percussion: false });
  return { p, old };
}
it('sustains harmony without generating Solo-like melodic attacks', () => {
  const { p, old } = fixture();
  const q = createChordChant(old, p, 'lead', [{ first: 1, last: 2 }]).project;
  for (const voice of q.parts.slice(1)) {
    const notes = voice.notes.filter(n => n.start < 8);
    expect(notes.length).toBeLessThanOrEqual(2);
    expect(notes.every(n => n.duration >= 4)).toBe(true);
    expect(notes.every(n => !n.lyric || n.lyric === 'Hmm')).toBe(true);
  }
  expect(q.parts[0]).toEqual(old.parts[0]);
  const tail = (project: typeof q) => project.parts.slice(1).map(v => v.notes
    .filter(n => n.start + n.duration > 8).map(({ id, ...n }) => ({ ...n,
      start: Math.max(8, n.start), duration: n.start + n.duration - Math.max(8, n.start) })));
  expect(tail(q)).toEqual(tail(old));
});
it('produces the same chant for repeated source/Solo music regardless of location or old background', () => {
  const { p, old } = fixture();
  old.parts.slice(1).forEach(v => v.notes.forEach(n => { if (n.start >= 8 && n.start < 16 && n.midi !== null) n.midi += 12; }));
  const q = createChordChant(old, p, 'lead', [{ first: 1, last: 2 }, { first: 5, last: 6 }]).project;
  for (const v of q.parts.slice(1)) {
    const excerpt = (start: number) => v.notes.filter(n => n.start >= start && n.start < start + 8)
      .map(({ id, ...n }) => ({ ...n, start: n.start - start }));
    expect(excerpt(16)).toEqual(excerpt(0));
  }
});
it('keeps actual bass arrivals and avoids crossed voices', () => {
  const { p, old } = fixture();
  const q = createChordChant(old, p, 'lead', [{ first: 1, last: 2 }]).project;
  for (const beat of [0, 4]) {
    const voices = q.parts.slice(1).map(v => v.notes.find(n => n.start <= beat && n.start + n.duration > beat)!.midi!);
    expect(voices[3] % 12).toBe(beat ? 9 : 0);
    expect(voices.every((pitch, i) => i === 0 || voices[i - 1] > pitch)).toBe(true);
  }
});
