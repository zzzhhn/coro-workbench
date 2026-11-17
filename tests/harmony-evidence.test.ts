import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { analyzeHarmonyEvidence } from '../src/lib/harmonyEvidence';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { createMelodicDialogue } from '../src/lib/melodicDialogue';

function fixture() {
  const p = createBlankProject(); p.measures = 4;
  p.parts = [p.parts[0], { ...structuredClone(p.parts[0]), id: 'accompaniment', role: 'instrument' }];
  p.parts.forEach(v => { v.notes = []; });
  p.chords = [];
  return p;
}
const note = (midi: number, start: number, duration: number) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: 0.7 });
describe('accompaniment harmonic evidence', () => {
  it('does not change harmony when Solo ornaments change', () => {
    const p = fixture(); p.parts[1].notes = [48, 52, 55].map(m => note(m, 0, 16));
    const before = analyzeHarmonyEvidence(p, p.parts[0].id);
    p.parts[0].notes = Array.from({ length: 64 }, (_, i) => note(61 + i % 12, i / 4, 0.25));
    expect(analyzeHarmonyEvidence(p, p.parts[0].id)).toEqual(before);
    expect(before.chords.map(c => c.symbol)).toEqual(['C']);
  });
  it('pools broken-chord members without changing harmony on every beat', () => {
    const p = fixture();
    p.parts[1].notes = Array.from({ length: 32 }, (_, i) => note([48, 55, 64, 67][i % 4], i * 0.5, 0.5));
    expect(analyzeHarmonyEvidence(p, p.parts[0].id).chords.map(c => c.symbol)).toEqual(['C']);
  });
  it('can distinguish a supported half-bar change and keeps silent gaps unassigned', () => {
    const p = fixture();
    p.parts[1].notes = [...[48, 52, 55].map(m => note(m, 0, 2)), ...[43, 47, 50, 53].map(m => note(m, 2, 2)), ...[48, 52, 55].map(m => note(m, 8, 4))];
    const result = analyzeHarmonyEvidence(p, p.parts[0].id);
    expect(result.chords.slice(0, 2).map(c => [c.start, c.duration, c.symbol])).toEqual([[0, 2, 'C'], [2, 2, 'G7']]);
    expect(result.chords.some(c => c.start < 8 && c.start + c.duration > 4)).toBe(false);
    expect(result.frames[4].review).toContain('伴奏无证据');
  });
  it('uses bass and extended tones without forcing every voicing into a triad', () => {
    const p = fixture(); p.parts[1].notes = [43, 57, 59, 62, 66].map(m => note(m, 0, 16));
    const before = analyzeHarmonyEvidence(p, p.parts[0].id);
    expect(before.chords.map(c => c.symbol)).toEqual(['Gmaj9']);
    p.parts[1].notes.forEach(n => { n.midi! += 2; });
    expect(analyzeHarmonyEvidence(p, p.parts[0].id).chords.map(c => c.symbol)).toEqual(['Amaj9']);
  });
  it('preserves attacks, durations, syllables and Solo in an explicit harmonic ablation', () => {
    const p = fixture();
    p.parts[0].notes = Array.from({ length: 16 }, (_, i) => note([67, 69, 71, 67][i % 4], i, 0.5));
    p.chords = [{ start: 0, duration: 16, symbol: 'C', pitches: [48, 52, 55] }];
    const source = arrangeV2(p, { preset: 'solo-satb', leadPartId: p.parts[0].id, transpose: 0, style: 'pop', difficulty: 'medium', percussion: false });
    const span = { first: 1, last: 4, intent: 'conversation' as const };
    const old = createMelodicDialogue(source, span);
    const same = createMelodicDialogue(source, span, { harmonicContext: source.chords });
    expect(same).toEqual(old);
    const changed = createMelodicDialogue(source, span, { harmonicContext: [{ start: 0, duration: 16, symbol: 'G', pitches: [55, 59, 62] }] });
    expect(changed.project.parts[0]).toEqual(old.project.parts[0]);
    expect(changed.trace).toEqual(old.trace);
    const schedule = (project: typeof source) => project.parts.map(v => v.notes.map(({ midi, ...n }) => n));
    expect(schedule(changed.project)).toEqual(schedule(old.project));
    expect(changed.project.parts.slice(1)).not.toEqual(old.project.parts.slice(1));
  });
});
