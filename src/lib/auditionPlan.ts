import type { ArrangementOptions, ArrangementPlan, ArrangementSectionPlan } from './types';

const allowed = {
  kind: ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'interlude', 'outro'],
  texture: ['bell', 'pad', 'sparse', 'rhythm', 'answer', 'lyric'],
  bass: ['sustain', 'pulse', 'groove'],
};

export function validateSectionWriting(
  s: Pick<ArrangementSectionPlan, 'energy' | 'texture' | 'bass' | 'rationale'>,
) {
  return (
    [1, 2, 3, 4, 5].includes(s.energy) &&
    allowed.texture.includes(s.texture) &&
    allowed.bass.includes(s.bass) &&
    typeof s.rationale === 'string' &&
    s.rationale.trim().length > 0
  );
}

/** External creative choices are constrained to what the shared realizer can actually play. */
export function wholeSongPlan(
  measures: number | undefined,
  sections: ArrangementSectionPlan[],
  model: string,
): ArrangementPlan {
  if (typeof model !== 'string' || !model.trim() || !Array.isArray(sections) || !sections.length || sections.length > 2048)
    throw Error('缺少全曲构思或规划来源。');
  let next = 1;
  const normalized = sections.map((s) => {
    if (
      !s ||
      s.startBar !== next ||
      !Number.isSafeInteger(s.bars) ||
      s.bars < 1 ||
      !allowed.kind.includes(s.kind) ||
      !validateSectionWriting(s) ||
      typeof s.label !== 'string' ||
      !s.label.trim()
    )
      throw Error('计划须按小节连续覆盖全曲，每段都要有可执行的声部决策和依据。');
    next += s.bars;
    return {
      id: 'section-' + s.startBar,
      kind: s.kind,
      startBar: s.startBar,
      bars: s.bars,
      label: s.label,
      energy: s.energy,
      texture: s.texture,
      bass: s.bass,
      rationale: s.rationale,
    };
  });
  if (next > 2049 || (measures !== undefined && next !== measures + 1)) throw Error('计划总长度与原谱不符。');
  return { version: 2, ensemble: 'solo+satb', planner: 'model', model, sections: normalized };
}

export function frozenFormPlan(options: ArrangementOptions, measures?: number): ArrangementPlan | undefined {
  const saved = options.formPlan;
  if (saved === undefined) return undefined;
  if (!saved || options.preset !== 'solo-satb' || !['groove', 'lyrical'].includes(options.engine ?? '') ||
      !/^[a-f0-9]{64}$/.test(saved.inputSHA256)) throw Error('全曲构思与编配选项不符。');
  return wholeSongPlan(measures, saved.sections, saved.model);
}
