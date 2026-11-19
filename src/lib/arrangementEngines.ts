import type { ArrangementSectionPlan } from './types';

/** Stable project-format keys shared by import, the workbench and auditions. */
export const arrangementMethods = {
  v2: '默认编配',
  'source-chant': '源谱吟唱',
  'open-chant': '舒展吟唱',
  lyrical: '乐句渐进',
  'jazz-ballad': '爵士抒情',
  groove: '低音律动',
} as const;
export type ArrangementEngine = keyof typeof arrangementMethods;


/** A source may have been extended or shortened since the sections were marked. */
export function validWrittenSections(sections: unknown, measures?: number): sections is ArrangementSectionPlan[] {
  if (!Array.isArray(sections) || !sections.length || sections.length > 2048) return false;
  let next = 1;
  for (const section of sections) {
    if (!section || section.startBar !== next || !Number.isSafeInteger(section.bars) || section.bars < 1
      || typeof section.id !== 'string' || !section.id || typeof section.label !== 'string' || !section.label.trim()
      || !['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'interlude', 'outro'].includes(section.kind)
      || ![1, 2, 3, 4, 5].includes(section.energy)
      || !['bell', 'pad', 'sparse', 'rhythm', 'answer', 'lyric'].includes(section.texture)
      || !['sustain', 'pulse', 'groove'].includes(section.bass)) return false;
    next += section.bars;
  }
  return next <= 2049 && (measures === undefined || next === measures + 1);
}
