import type { ArrangementOptions, ScorePart, ScoreProject } from './types';
import { beatsPerBar, validateProject } from './music';
import { arrangeV2 } from './arrangeV2';
import { inspectArrangement } from './arrange';
import { createSourceChant } from './sourceChant';

/** Separator for a virtual part made from one staff of a multi-staff part. */
const STAFF = '::staff-';

export interface ChantSourceOption {
  id: string;
  label: string;
  /** Median pitch, used to order options and to pick a default bass. */
  register: number;
}

function staffNumbers(part: ScorePart): number[] {
  const declared = part.staves?.map((staff) => staff.number) ?? [];
  const used = part.notes.map((note) => note.staff).filter((staff): staff is number => staff !== undefined);
  return [...new Set([...declared, ...used])].sort((a, b) => a - b);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 60;
}

/**
 * Parts that can supply accompaniment evidence. A grand-staff piano (one part,
 * staves 1 and 2) becomes two options so its lower staff can act as the bass.
 */
export function chantSourceOptions(project: ScoreProject, leadPartId?: string): ChantSourceOption[] {
  const options: ChantSourceOption[] = [];
  for (const part of project.parts) {
    if (part.role === 'percussion' || part.id === leadPartId) continue;
    const pitched = part.notes.filter((note) => note.midi !== null);
    if (!pitched.length) continue;
    const staves = staffNumbers(part);
    if (staves.length > 1) {
      for (const staff of staves) {
        const notes = pitched.filter((note) => (note.staff ?? staves[0]) === staff);
        if (notes.length)
          options.push({ id: `${part.id}${STAFF}${staff}`, label: `${part.name} · 第 ${staff} 谱表`, register: median(notes.map((note) => note.midi!)) });
      }
    } else options.push({ id: part.id, label: part.name, register: median(pitched.map((note) => note.midi!)) });
  }
  // Identical track names (two "acoustic grand piano" MIDI tracks) need a distinguishing suffix.
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  for (const option of options)
    if ((counts.get(option.label) ?? 0) > 1)
      option.label = `${option.label}（第 ${project.parts.findIndex((part) => part.id === option.id.split(STAFF)[0]) + 1} 轨）`;
  return options.sort((a, b) => b.register - a.register);
}

/** Default evidence: keyboard parts when present, otherwise every candidate; bass = lowest. */
export function defaultChantSelection(project: ScoreProject, leadPartId?: string) {
  const options = chantSourceOptions(project, leadPartId);
  const keyboard = options.filter((option) => {
    const part = project.parts.find((item) => item.id === option.id.split(STAFF)[0]);
    return part !== undefined && part.program >= 0 && part.program <= 7;
  });
  const chosen = keyboard.length ? keyboard : options;
  return { accompanimentIds: chosen.map((option) => option.id), bassPartId: chosen.at(-1)?.id };
}

/** Build a source copy whose parts are the selected (possibly per-staff) evidence. */
function evidenceSource(source: ScoreProject, ids: string[], transpose: number): ScoreProject {
  const copy = structuredClone(source);
  copy.parts = ids.map((id) => {
    const [partId, staffText] = id.split(STAFF);
    const part = source.parts.find((item) => item.id === partId);
    if (!part) throw new Error('所选伴奏声部不存在，请重新选择。');
    const staves = staffNumbers(part);
    const staff = staffText === undefined ? undefined : Number(staffText);
    return {
      ...structuredClone(part),
      id,
      staves: undefined,
      notes: part.notes
        .filter((note) => note.midi !== null && (staff === undefined || (note.staff ?? staves[0]) === staff))
        .map((note) => ({ ...note, midi: note.midi! + transpose, staff: undefined })),
    };
  });
  return copy;
}

/** Inside a long unaccompanied-by-Solo phrase, expose the written upper line,
 * then hand the ear back to the inner voices before the singer's pickup. */
function shapeInstrumentalReturns(project: ScoreProject) {
  const lead = project.parts.find(part => part.role === 'lead');
  if (!lead) return;
  const bar = beatsPerBar(project);
  let previousEnd = 0;
  for (const note of [...lead.notes].filter(n => n.midi !== null).sort((a, b) => a.start - b.start)) {
    const from = Math.ceil(previousEnd / bar) * bar;
    const end = Math.floor(note.start / bar) * bar;
    if (previousEnd > 0 && end - from >= 2 * bar) {
      const handoff = from + Math.max(1, Math.floor((end - from) / bar / 2)) * bar;
      // Bass carries through the exchange. Take breathing space only within
      // this interlude, retaining any onset or release outside its boundaries.
      for (const [id, a, b] of [['voice-a', from, handoff], ['voice-s', handoff, end]] as const) {
        const part = project.parts.find(p => p.id === id);
        if (!part) continue;
        part.notes = part.notes.flatMap(n => {
          const until = n.start + n.duration;
          if (until <= a || n.start >= b) return [n];
          return [...(n.start < a ? [{ ...n, duration: a - n.start }] : []),
            ...(until > b ? [{ ...n, id: n.id + '-return', start: b, duration: until - b, lyric: 'Ooh' }] : [])];
        });
      }
    }
    previousEnd = Math.max(previousEnd, note.start + note.duration);
  }
}

/**
 * Experimental Solo + SATB: the Solo and ensemble come from arrangeV2, then the
 * backing is rebuilt from the reliable source accompaniment as quiet chant.
 * Uses the personal-computer full-song configuration (`vocal-core`, arpeggio
 * recovery). No reference arrangement, song name or bar number is consulted.
 */
export function arrangeSourceChant(source: ScoreProject, options: ArrangementOptions): ScoreProject {
  const scaffold = arrangeV2(source, { ...options, engine: 'v2' });
  const leadPartId = scaffold.arrangement?.options.leadPartId;
  const fallback = defaultChantSelection(source, leadPartId);
  const accompanimentIds = (options.accompanimentIds?.length ? options.accompanimentIds : fallback.accompanimentIds)
    .filter((id) => id.split(STAFF)[0] !== leadPartId);
  const bassPartId = options.bassPartId && accompanimentIds.includes(options.bassPartId)
    ? options.bassPartId
    : chantSourceOptions(source, leadPartId).filter((option) => accompanimentIds.includes(option.id)).at(-1)?.id;
  if (!accompanimentIds.length || !bassPartId)
    throw new Error('源谱吟唱需要原谱里至少一个伴奏声部，并指定其中一个作为低音。');
  const evidence = evidenceSource(source, accompanimentIds, options.transpose);
  let chant;
  try {
    chant = createSourceChant(scaffold, evidence, { accompanimentIds, bassPartId }, [{ first: 1, last: source.measures }], {
      harmony: 'vocal-core',
      openVoicing: options.engine === 'open-chant',
      recoverInstrumentalArpeggios: true,
      variant: options.variant,
    });
  } catch (error) {
    throw new Error(`源谱吟唱无法为这份谱生成可唱的四声部：${error instanceof Error ? error.message : String(error)}。可换伴奏声部或改用默认编配。`);
  }
  const project = chant.project;
  if (options.engine === 'open-chant') shapeInstrumentalReturns(project);
  const bar = beatsPerBar(project);
  const labels = chantSourceOptions(source, leadPartId);
  const name = (id: string) => labels.find((option) => option.id === id)?.label ?? id;
  const omitted = chant.slices.filter((slice) => slice.omitted.length).length;
  const changes = [
    `实验编配·源谱吟唱：S/A/T/B 来自原谱伴奏的和声落点（${accompanimentIds.map(name).join('、')}；低音取「${name(bassPartId)}」），以长音吟唱呈现。Solo 与默认编配完全相同。`,
    `识别出 ${chant.anchors.length} 个和声落点，其中 ${chant.anchors.filter((anchor) => anchor.reason === 'instrumental-arpeggio').length} 个来自分解和弦；安排 ${chant.breaths.length} 处换气。`,
    ...(options.engine === 'open-chant' ? ['相同旋律与和声落点优先复用配音，提高女高和男高的舒适重心；间奏让上声部交替接句。'] : []),
    ...(omitted ? [`${omitted} 处原谱和弦超过四个音级，已保留低音和最高的源谱音，其余音级省略。`] : []),
    '此实验只在个人电脑上《空耳》的部分片段（13–20、21–28、45–52 小节）获得过试听认可；其他段落和其他歌曲都还未经听感验收。',
  ];
  const silentBars = Array.from({ length: project.measures }, (_, index) => index).filter(
    (index) => !project.parts.slice(1).some((part) => part.notes.some(
      (note) => note.midi !== null && note.start < (index + 1) * bar && note.start + note.duration > index * bar)),
  );
  const warnings = silentBars.length
    ? [`${silentBars.length} 个小节原谱伴奏没有可用的和声落点，背景声部保持休止（例如第 ${silentBars.slice(0, 5).map((index) => index + 1).join('、')} 小节）。`]
    : [];
  project.arrangement = {
    options: { ...options, preset: 'solo-satb', percussion: false, leadPartId, engine: options.engine === 'open-chant' ? 'open-chant' : 'source-chant', accompanimentIds, bassPartId },
    plan: scaffold.arrangement?.plan,
    report: { changes, warnings, ranges: [] },
  };
  const inspection = inspectArrangement(project);
  project.arrangement.report = { ...inspection, changes, warnings: [...warnings, ...inspection.warnings] };
  const errors = validateProject(project);
  if (errors.length) throw new Error(`编配验证失败：${errors.join('\n')}`);
  return project;
}
