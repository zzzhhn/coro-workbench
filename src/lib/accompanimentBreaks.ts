import { validateSectionWriting } from './auditionPlan';
import { beatsPerBar } from './music';
import type { ArrangementPlan, ArrangementSectionPlan, ScoreProject } from './types';

export interface AccompanimentBreak {
  first: number;
  last: number;
  parts: Array<{ name: string; attacks: number; onsetFractions: number[] }>;
}

/** Only propose internal phrases with sounding pitched accompaniment throughout.
 * A held Solo note across the barline still counts as singing. */
export function accompanimentBreaks(source: ScoreProject, leadId: string): AccompanimentBreak[] {
  const lead = source.parts.find((p) => p.id === leadId);
  if (!lead) throw Error('选定的主旋律声部不存在。');
  const bar = beatsPerBar(source);
  const pitched = source.parts.filter((p) => p.id !== leadId && p.role !== 'percussion');
  const solo = lead.notes.filter((n) => n.midi !== null);
  if (!solo.length) return [];
  const start = Math.min(...solo.map((n) => n.start));
  const finish = Math.max(...solo.map((n) => n.start + n.duration));
  const spans: Array<{ first: number; last: number }> = [];
  for (let i = 0; i < source.measures; i++) {
    const from = i * bar,
      to = from + bar;
    const sounds = (n: (typeof solo)[number]) =>
      n.midi !== null && n.start < to - 1e-6 && n.start + n.duration > from + 1e-6;
    if (from < start || to > finish || solo.some(sounds) || !pitched.some((p) => p.notes.some(sounds)))
      continue;
    const prev = spans.at(-1);
    if (prev?.last === i) prev.last++;
    else spans.push({ first: i + 1, last: i + 1 });
  }
  return spans
    .filter((s) => s.last > s.first)
    .map((s) => ({
      ...s,
      parts: pitched.map((p) => {
        const notes = p.notes.filter(
          (n) => n.midi !== null && n.start >= (s.first - 1) * bar && n.start < s.last * bar,
        );
        const attacks = [...new Set(notes.map((n) => Math.round(n.start * 1000) / 1000))];
        return {
          name: p.name,
          attacks: attacks.length,
          onsetFractions: [...new Set(attacks.map((t) => Math.round((t % 1) * 100) / 100))].sort(
            (a, b) => a - b,
          ),
        };
      }),
    }));
}

export interface BreakDecision {
  first: number;
  last: number;
  energy: ArrangementSectionPlan['energy'];
  texture: ArrangementSectionPlan['texture'];
  bass: ArrangementSectionPlan['bass'];
  rationale: string;
}

export function planAccompanimentBreaks(
  base: ArrangementPlan,
  spans: AccompanimentBreak[],
  decisions: BreakDecision[],
  model: string,
): ArrangementPlan {
  if (typeof model !== 'string' || !model.trim() || !Array.isArray(decisions))
    throw Error('缺少计划来源或段落决策。');
  const used = new Set<number>();
  for (const d of decisions) {
    if (
      !d ||
      !spans.some((s) => s.first === d.first && s.last === d.last) ||
      used.has(d.first) ||
      !validateSectionWriting(d)
    )
      throw Error('间奏决策无效，或与源谱证据不一致。');
    used.add(d.first);
  }
  const sections: ArrangementSectionPlan[] = [];
  for (const original of base.sections) {
    const end = original.startBar + original.bars;
    let cursor = original.startBar;
    while (cursor < end) {
      const d = decisions.find((x) => x.first <= cursor && cursor <= x.last);
      if (d) {
        if (cursor === d.first)
          sections.push({
            kind: 'interlude',
            id: 'break-' + cursor,
            label: '器乐段',
            startBar: cursor,
            bars: d.last - cursor + 1,
            energy: d.energy,
            texture: d.texture,
            bass: d.bass,
            rationale: d.rationale,
          });
        cursor = Math.min(end, d.last + 1);
      } else {
        const stop = Math.min(end, ...decisions.filter((x) => x.first > cursor).map((x) => x.first));
        sections.push({
          ...original,
          id: cursor === original.startBar ? original.id : original.id + '-' + cursor,
          startBar: cursor,
          bars: stop - cursor,
        });
        cursor = stop;
      }
    }
  }
  return { ...base, planner: 'model', model, sections };
}
