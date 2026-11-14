// Printed layout: system and page breaks, and what each system repeats.
//
// Crescendo (B/C-level evidence: Edit > 小节布局 在新谱表上 / 在新页面上; Score >
// 设置段落标签重复 / 谱号重复 / 调号重复 with 仅第一个谱表 / 每页上的第一个谱表 /
// 每个谱表). Independent implementation: breaks are bar numbers in the project,
// applied by toAbc (systems) and the PDF writer (pages); repeat rules are applied
// to the parsed abcjs tune before drawing.
import type { RepeatRule, ScoreLayout, ScoreProject } from './types';

export const DEFAULT_LAYOUT: ScoreLayout = {
  systemBreaks: [],
  pageBreaks: [],
  repeat: { clef: 'every', key: 'every', labels: 'every' },
};

const RULES: RepeatRule[] = ['first', 'page', 'every'];

export function layoutOf(project: Pick<ScoreProject, 'layout'>): ScoreLayout {
  const layout = project.layout;
  if (!layout) return DEFAULT_LAYOUT;
  return {
    systemBreaks: layout.systemBreaks ?? [],
    pageBreaks: layout.pageBreaks ?? [],
    repeat: { ...DEFAULT_LAYOUT.repeat, ...(layout.repeat ?? {}) },
  };
}

export function validateLayout(layout: unknown, measures: number): string | undefined {
  if (layout === undefined) return undefined;
  const value = layout as ScoreLayout;
  const bars = (list: unknown) =>
    Array.isArray(list) &&
    list.length <= 4096 &&
    list.every((bar) => Number.isInteger(bar) && bar >= 2 && bar <= Math.max(2, measures));
  if (!value || typeof value !== 'object') return '排版设置无效。';
  if (!bars(value.systemBreaks) || !bars(value.pageBreaks)) return '换行 / 换页小节无效。';
  const repeat = value.repeat as Record<string, unknown> | undefined;
  if (!repeat || ['clef', 'key', 'labels'].some((key) => !RULES.includes(repeat[key] as RepeatRule)))
    return '谱号 / 调号 / 声部名重复规则无效。';
  return undefined;
}

/**
 * First bars (1-based) of each system in [first, last]: forced breaks first,
 * then automatic systems of `perSystem` bars after each forced start.
 */
export function planSystems(
  layout: ScoreLayout,
  first: number,
  last: number,
  perSystem: (bar: number) => number,
): { starts: number[]; pageStarts: number[] } {
  const forced = new Set([...layout.systemBreaks, ...layout.pageBreaks]);
  const pages = new Set(layout.pageBreaks);
  const starts: number[] = [];
  const pageStarts: number[] = [0];
  let bar = first;
  while (bar <= last) {
    starts.push(bar);
    if (pages.has(bar) && starts.length > 1) pageStarts.push(starts.length - 1);
    let next = bar + Math.max(1, perSystem(bar));
    // A forced break inside this automatic system ends it early.
    for (let candidate = bar + 1; candidate < next; candidate++)
      if (forced.has(candidate)) {
        next = candidate;
        break;
      }
    bar = next;
  }
  return { starts, pageStarts };
}

/** Whether a repeat rule prints on system `index` (0 = first system shown). */
export function repeatsOn(rule: RepeatRule, index: number, pageStarts: number[]): boolean {
  if (index === 0) return true;
  if (rule === 'every') return true;
  if (rule === 'page') return pageStarts.includes(index);
  return false;
}

const toggle = (list: number[], bar: number) =>
  list.includes(bar) ? list.filter((item) => item !== bar) : [...list, bar].sort((a, b) => a - b);

/** Toggle "start a new system here" at a bar (bar 1 is always a system start). */
export function toggleSystemBreak(project: ScoreProject, bar: number): ScoreProject {
  if (bar < 2 || bar > project.measures) throw new Error('第 1 小节总是新的一行。');
  const layout = layoutOf(project);
  return {
    ...project,
    layout: { ...layout, systemBreaks: toggle(layout.systemBreaks, bar) },
    updatedAt: new Date().toISOString(),
  };
}

/** Toggle "start a new page here" at a bar. */
export function togglePageBreak(project: ScoreProject, bar: number): ScoreProject {
  if (bar < 2 || bar > project.measures) throw new Error('第 1 小节总是在第一页。');
  const layout = layoutOf(project);
  return {
    ...project,
    layout: { ...layout, pageBreaks: toggle(layout.pageBreaks, bar) },
    updatedAt: new Date().toISOString(),
  };
}

export function setRepeatRule(
  project: ScoreProject,
  what: keyof ScoreLayout['repeat'],
  rule: RepeatRule,
): ScoreProject {
  const layout = layoutOf(project);
  return {
    ...project,
    layout: { ...layout, repeat: { ...layout.repeat, [what]: rule } },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Keep breaks attached to their music when bars are inserted or deleted:
 * a break at or after the edit point moves with it; a break inside deleted bars
 * moves to the first bar after them.
 */
export function shiftLayout(
  project: ScoreProject,
  edit: { at: number; inserted: number } | { from: number; to: number },
): ScoreProject {
  if (!project.layout) return project;
  const map = (bar: number): number | undefined => {
    if ('inserted' in edit) return bar >= edit.at ? bar + edit.inserted : bar;
    const removed = edit.to - edit.from + 1;
    if (bar < edit.from) return bar;
    if (bar <= edit.to) return edit.from;
    return bar - removed;
  };
  const move = (list: number[]) =>
    [
      ...new Set(
        list
          .map(map)
          .filter((bar): bar is number => bar !== undefined && bar >= 2 && bar <= project.measures),
      ),
    ].sort((a, b) => a - b);
  return {
    ...project,
    layout: {
      ...project.layout,
      systemBreaks: move(project.layout.systemBreaks),
      pageBreaks: move(project.layout.pageBreaks),
    },
  };
}
