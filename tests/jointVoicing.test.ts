import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { realizeJointVoicing } from '../src/lib/jointVoicing';

function fixture(pitches = [72, 64, 55, 48]) {
  const p = createBlankProject(); p.measures = 2;
  const part = p.parts[0];
  p.parts = ['solo', 'voice-s', 'voice-a', 'voice-t', 'voice-b'].map((id, i) => ({
    ...structuredClone(part), id, notes: i === 0 ? [] : [{ id: id + '-note', start: 0, duration: 8, midi: pitches[i - 1], velocity: 0.5, lyric: 'Ooh' }],
  }));
  p.chords = [{ start: 0, duration: 8, symbol: 'C', pitches: [48, 52, 55] }];
  return p;
}
const at = (p: ReturnType<typeof fixture>, beat: number) => p.parts.slice(1).map(v => v.notes.find(n => n.start <= beat && n.start + n.duration > beat)!.midi!);
describe('joint ensemble realization', () => {
  it('keeps an already balanced voicing and does not manufacture attacks', () => {
    const p = fixture(), saved = structuredClone(p);
    const { project } = realizeJointVoicing(p, { first: 1, last: 2 });
    expect(project.parts).toEqual(p.parts);
    expect(p).toEqual(saved);
  });
  it('moves bass at the new harmonic arrival and retains common upper tones', () => {
    const p = fixture();
    p.chords = [{ start: 0, duration: 4, symbol: 'C', pitches: [48, 52, 55] }, { start: 4, duration: 4, symbol: 'Am7', pitches: [57, 48, 52, 55] }];
    const q = realizeJointVoicing(p, { first: 1, last: 2 }).project;
    expect(at(q, 4)[3] % 12).toBe(9);
    expect(q.parts.slice(1, 4).map(v => v.notes)).toEqual(p.parts.slice(1, 4).map(v => v.notes));
    expect(q.parts[4].notes.map(n => [n.start, n.duration])).toEqual([[0, 4], [4, 4]]);
    expect(q.parts[4].notes[1].lyric).toBe('');
  });
  it('honors an explicit inversion rather than an inherited bass target', () => {
    const p = fixture(); p.chords[0].symbol = 'C/E';
    const q = realizeJointVoicing(p, { first: 1, last: 2 }).project;
    expect(at(q, 0)[3] % 12).toBe(4);
  });
  it('does not turn missing harmonic evidence into a new attack or pitch reset', () => {
    const p = fixture([72, 63, 55, 48]); p.chords[0].duration = 4;
    const q = realizeJointVoicing(p, { first: 1, last: 2 }).project;
    expect(q.parts[2].notes).toHaveLength(1);
    expect(q.parts[2].notes[0].midi).toBe(64);
    expect(q.parts[2].notes[0].duration).toBe(8);
  });
  it('rejects an unsupported chromatic neighbour without deleting its rhythmic gesture', () => {
    const p = fixture([69, 64, 60, 45]);
    p.chords = [{ start: 0, duration: 8, symbol: 'Am9', pitches: [57, 48, 52, 55, 59] }];
    p.parts[1].notes = [69, 70, 69].map((midi, i) => ({ id: `s-${i}`, midi, start: i * 0.5, duration: i === 2 ? 7 : 0.5, velocity: 0.5, lyric: 'doo' }));
    const q = realizeJointVoicing(p, { first: 1, last: 2 }).project;
    expect(q.parts[1].notes.map(n => n.midi)).not.toContain(70);
    expect(q.parts[1].notes.map(n => [n.start, n.duration])).toEqual(p.parts[1].notes.map(n => [n.start, n.duration]));
  });
  it('gives an exposed ensemble a third and avoids crossing without deleting notes', () => {
    const p = fixture([67, 60, 55, 48]);
    const q = realizeJointVoicing(p, { first: 1, last: 2 }).project, pitches = at(q, 0);
    expect(pitches.map(n => n % 12)).toContain(4);
    expect(pitches.every((n, i) => i === 0 || pitches[i - 1] > n)).toBe(true);
    expect(q.parts.slice(1).map(v => v.notes.reduce((s, n) => s + n.duration, 0))).toEqual([8, 8, 8, 8]);
  });
  it('preserves Solo and notes outside a bounded rewrite', () => {
    const p = fixture(); p.measures = 3;
    p.parts[0].notes = [{ id: 'lead', start: 0, duration: 12, midi: 77, velocity: 0.7, lyric: 'word' }];
    p.parts.slice(1).forEach(v => v.notes.push({ ...v.notes[0], id: v.id + '-outside', start: 8, duration: 4 }));
    const q = realizeJointVoicing(p, { first: 1, last: 2 }).project;
    expect(q.parts[0]).toEqual(p.parts[0]);
    q.parts.slice(1).forEach((v, i) => expect(v.notes.filter(n => n.start >= 8)).toEqual(p.parts[i + 1].notes.filter(n => n.start >= 8)));
    expect(q.chords).toEqual(p.chords);
  });
  it('structural mode retains third and seventh before optional ninth colors', () => {
    const p = fixture([74, 69, 55, 48]);
    p.parts[0].notes = [{ id: 'solo', start: 0, duration: 8, midi: 67, velocity: .7 }];
    p.chords = [{ start: 0, duration: 8, symbol: 'Cmaj9', pitches: [48, 52, 55, 59, 62] }];
    const q = realizeJointVoicing(p, { first: 1, last: 2 }, { structural: true }).project;
    const pcs = at(q, 0).map(n => n % 12);
    expect(pcs).toContain(4); expect(pcs).toContain(11);
    expect(q.parts[0]).toEqual(p.parts[0]);
  });

  it('uses the unquantized cell direction instead of learning a previous collapsed contour', () => {
    const p = fixture([71, 66, 59, 43]);
    p.chords = [{ start: 0, duration: 8, symbol: 'Gmaj9', pitches: [55, 59, 62, 66, 69] }];
    p.parts[0].notes = [{ id: 'solo', start: 0, duration: 8, midi: 62, velocity: .7 }];
    p.parts[1].notes = [71, 71, 71, 74].map((midi, i) => ({ id: `s-${i}`, start: i * .5, duration: i === 3 ? 6.5 : .5, midi, velocity: .5 }));
    const targets = [74, 72, 72, 76].map((target, i) => ({ voice: 'voice-s', start: i * .5, target, motif: 'descending-answer' }));
    const q = realizeJointVoicing(p, { first: 1, last: 2 }, { structural: true, targets }).project;
    const ns = q.parts[1].notes;
    expect(ns[1].midi!).toBeLessThan(ns[0].midi!);
    expect(ns[2].midi).toBe(ns[1].midi);
    expect(ns[3].midi!).toBeGreaterThan(ns[2].midi!);
    expect(ns.map(n => [n.start, n.duration])).toEqual(p.parts[1].notes.map(n => [n.start, n.duration]));
  });

});
