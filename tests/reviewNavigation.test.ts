import { describe, expect, it } from 'vitest';
import { reviewSections } from '../review/navigation';
import type { ScoreProject } from '../src/lib/types';

const project = (measures: number, label: string) => ({
  measures,
  arrangement: { plan: { sections: [{ label, startBar: 1, bars: measures }] } },
}) as ScoreProject;

describe('blind review navigation', () => {
  it('uses identical anonymous 8-bar ranges regardless of version order or named structure', () => {
    const a = project(17, 'A source-specific section');
    const b = project(15, 'B different structure');
    const sections = reviewSections([a, b]);
    expect(sections).toEqual(reviewSections([b, a]));
    expect(sections.map(s => [s.label, s.start, s.end])).toEqual([
      ['全曲', 1, 17], ['1–8 小节', 1, 8], ['9–16 小节', 9, 16], ['17 小节', 17, 17],
    ]);
    expect(JSON.stringify(sections)).not.toContain('source-specific');
    expect(JSON.stringify(sections)).not.toContain('different structure');
  });

  it('bounds a shorter version’s anonymous ranges to bars it contains', () => {
    const a = project(17, 'Original');
    const b = project(11, 'Trimmed');
    expect(reviewSections([a, b], b).map(s => [s.label, s.start, s.end])).toEqual([
      ['全曲', 1, 11], ['1–8 小节', 1, 8], ['9–11 小节', 9, 11],
    ]);
    expect(reviewSections([a, b], a).at(-1)?.start).toBe(17);
  });

  it('keeps first-draft sections without duplicate selector values', () => {
    const sections = reviewSections([project(8, 'Verse')]);
    expect(sections.map(s => s.id)).toEqual(['all', 'section-0']);
    expect(sections[1].label).toBe('Verse · 1–8');
    expect(reviewSections([project(8, 'Source identifying intro')], undefined, true)[1].label).toBe('1–8 小节');
  });

  it('rejects absent or invalid score lengths rather than inventing ranges', () => {
    expect(() => reviewSections([])).toThrow();
    expect(() => reviewSections([project(0, '')])).toThrow();
  });
});
