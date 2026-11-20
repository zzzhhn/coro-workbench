import type { ScoreProject } from '../src/lib/types';

export interface ReviewSection { id: string; label: string; start: number; end: number }

/** A/B uses neutral ranges, bounded by the selected version's actual form. */
export function reviewSections(projects: readonly ScoreProject[], selected?: ScoreProject, anonymous = false): ReviewSection[] {
  if (!projects.length || projects.some(p => !Number.isInteger(p.measures) || p.measures < 1)) throw new Error('乐谱小节数无效。');
  const measures = selected?.measures ?? Math.max(...projects.map(p => p.measures));
  const all = { id: 'all', label: '全曲', start: 1, end: measures };
  if (anonymous || projects.length > 1) {
    return [all, ...Array.from({ length: Math.ceil(measures / 8) }, (_, index) => {
      const start = index * 8 + 1;
      const end = Math.min(measures, start + 7);
      return { id: `range-${start}`, label: `${start === end ? start : `${start}–${end}`} 小节`, start, end };
    })];
  }
  return [all, ...(projects[0].arrangement?.plan?.sections ?? []).map((s, i) => ({ id: `section-${i}`, label: `${s.label} · ${s.startBar}–${Math.min(measures, s.startBar + s.bars - 1)}`, start: s.startBar, end: Math.min(measures, s.startBar + s.bars - 1) }))];
}
