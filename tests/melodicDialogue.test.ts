import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { createMelodicDialogue } from '../src/lib/melodicDialogue';
import { validateProject } from '../src/lib/music';

function fixture() {
  const p = createBlankProject(); p.measures = 8;
  p.parts[0].notes = Array.from({ length: 8 }, (_, i) => [0, 1, 2, 3].map((j) => ({ id: `n${i}-${j}`, start: i * 4 + j * 0.5, duration: 0.5, midi: [67, 69, 71, 67][j], velocity: 0.7 }))).flat();
  p.chords = Array.from({ length: 8 }, (_, i) => ({ start: i * 4, duration: 4, symbol: i % 2 ? 'G' : 'C', pitches: i % 2 ? [55, 59, 62] : [48, 52, 55] }));
  return arrangeV2(p, { preset: 'solo-satb', leadPartId: p.parts[0].id, transpose: 0, style: 'pop', difficulty: 'medium', percussion: false });
}
describe('melodic dialogue audition', () => {
  it('keeps the Solo, ensemble and outside notes while passing one input cell between singers', () => {
    const source = fixture(), frozen = structuredClone(source);
    const result = createMelodicDialogue(source, { first: 3, last: 6, intent: 'conversation' });
    expect(source).toEqual(frozen); expect(result.project.parts[0]).toEqual(source.parts[0]);
    expect(result.project.parts.map(p => p.id)).toEqual(source.parts.map(p => p.id));
    expect(validateProject(result.project)).toEqual([]);
    expect(new Set(result.trace.filter(g => g.motif).map(g => g.motif)).size).toBe(1);
    expect(new Set(result.trace.filter(g => g.role === 'statement' || g.role === 'answer').map(g => g.voice)).size).toBeGreaterThan(1);
    for (const part of result.project.parts.slice(1)) {
      expect(part.notes.filter(n => n.start < 8 || n.start >= 24)).toEqual(source.parts.find(p => p.id === part.id)!.notes.filter(n => n.start < 8 || n.start >= 24));
      const sorted = [...part.notes].sort((a, b) => a.start - b.start);
      sorted.slice(1).forEach((n, i) => expect(sorted[i].start + sorted[i].duration).toBeLessThanOrEqual(n.start + 1e-6));
    }
  });
  it('derives the motif from input and never the title', () => {
    const p = fixture(), span = { first: 1, last: 8, intent: 'lift' as const };
    const before = createMelodicDialogue(p, span);
    p.title = 'Another title'; expect(createMelodicDialogue(p, span).project.parts).toEqual(before.project.parts);
    p.parts[0].notes.forEach((n, i) => { n.midi = [67, 64, 62, 64][i % 4]; });
    expect(createMelodicDialogue(p, span).seed.contour).not.toEqual(before.seed.contour);
  });
  it('does not silently invent a motive when the input lacks melodic evidence', () => {
    const p = fixture(); p.parts[0].notes = p.parts[0].notes.slice(0, 2);
    expect(() => createMelodicDialogue(p, { first: 1, last: 8, intent: 'flow' })).toThrow('stable Solo');
  });
});
