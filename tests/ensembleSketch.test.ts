import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { createEnsembleSketch } from '../src/lib/ensembleSketch';
import { validateProject } from '../src/lib/music';

function fixture() {
  const source = createBlankProject();
  source.measures = 8;
  source.parts[0].notes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, start: i * 4, duration: 2, midi: 67 + i % 3, velocity: 0.7 }));
  source.chords = Array.from({ length: 8 }, (_, i) => ({ start: i * 4, duration: 4, symbol: i % 2 ? 'F' : 'C', pitches: i % 2 ? [53, 57, 60] : [48, 52, 55] }));
  return arrangeV2(source, { preset: 'solo-satb', leadPartId: source.parts[0].id, transpose: 0, style: 'pop', difficulty: 'medium', percussion: false });
}
describe('bounded ensemble sketches', () => {
  it.each(['flow', 'conversation', 'lift'] as const)('preserves Solo, source and settings, with noncrossing monophonic %s lines', intent => {
    const source = fixture(), before = structuredClone(source);
    const { project, trace } = createEnsembleSketch(source, { first: 3, last: 6, intent });
    expect(source).toEqual(before); expect(project.parts[0]).toEqual(source.parts[0]);
    for (const key of ['tempo', 'timeSignature', 'chords', 'key', 'measures'] as const) expect(project[key]).toEqual(source[key]);
    expect(validateProject(project)).toEqual([]);
    for (let v = 1; v < 5; v++) {
      const { notes, ...settings } = project.parts[v], { notes: old, ...original } = source.parts[v];
      expect(settings).toEqual(original);
      expect(notes.filter(n => n.start < 8 || n.start >= 24)).toEqual(old.filter(n => n.start < 8 || n.start >= 24));
      for (let i = 1; i < notes.length; i++) expect(notes[i - 1].start + notes[i - 1].duration).toBeLessThanOrEqual(notes[i].start + 1e-6);
    }
    expect(trace.every(g => g.pitches.every((p, i) => i === 3 || p > g.pitches[i + 1]))).toBe(true);
  });
  it('responds to phrase gaps without making a voice exclusively dependent on them', () => {
    const source = fixture();
    const open = createEnsembleSketch(source, { first: 1, last: 8, intent: 'conversation' });
    expect(open.trace.some(g => g.kind === 'answer')).toBe(true);
    source.parts[0].notes.forEach(n => { n.duration = 4; });
    const busy = createEnsembleSketch(source, { first: 1, last: 8, intent: 'conversation' });
    expect(busy.trace.some(g => g.kind === 'answer')).toBe(false);
    expect(busy.project.parts.slice(1).every(p => p.notes.length > 0)).toBe(true);
    expect(busy.trace).not.toEqual(open.trace);
  });
  it('does not use song identity, and refuses missing harmonic evidence', () => {
    const source = fixture();
    const a = createEnsembleSketch(source, { first: 1, last: 8, intent: 'flow' });
    source.title = 'Unseen song';
    expect(createEnsembleSketch(source, { first: 1, last: 8, intent: 'flow' }).trace).toEqual(a.trace);
    source.chords = [];
    expect(() => createEnsembleSketch(source, { first: 1, last: 8, intent: 'flow' })).toThrow('harmonic evidence');
  });
});
