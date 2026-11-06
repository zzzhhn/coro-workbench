import type { NoteEvent, ScoreProject } from './types';
import { beatsPerBar, transposeChordSymbol, transposeKey, validateProject } from './music';
import { inspectArrangement } from './arrange';

export interface RepairSelection {
  partIds: string[];
  startMeasure: number;
  endMeasure: number;
}

export interface RepairResult {
  project: ScoreProject;
  changedNotes: number;
  warnings: string[];
}

export type StaffLayout = 'auto' | 'treble' | 'bass' | 'grand';

const EPSILON = 1e-8;
const SUPPORTED_QUANTIZE_STEPS = [1, 0.5, 0.25, 2 / 3, 1 / 3, 1 / 6];

function assertProject(project: ScoreProject): void {
  const errors = validateProject(project);
  if (errors.length) throw new Error(`乐谱无法校正：${errors.slice(0, 3).join('；')}`);
}

function selectedRange(project: ScoreProject, selection: RepairSelection) {
  assertProject(project);
  if (
    !selection ||
    !Array.isArray(selection.partIds) ||
    !selection.partIds.length ||
    selection.partIds.some((id) => typeof id !== 'string' || !project.parts.some((part) => part.id === id)) ||
    !Number.isInteger(selection.startMeasure) ||
    !Number.isInteger(selection.endMeasure) ||
    selection.startMeasure < 1 ||
    selection.endMeasure < selection.startMeasure ||
    selection.endMeasure > project.measures
  )
    throw new Error('请选择有效声部及工程范围内的起止小节。');
  const length = beatsPerBar(project);
  const partIds = new Set(selection.partIds);
  const start = (selection.startMeasure - 1) * length;
  const end = selection.endMeasure * length;
  const contains = (partId: string, note: NoteEvent) =>
    partIds.has(partId) && note.start >= start && note.start < end;
  return { partIds, start, end, contains };
}

function crossingWarnings(
  project: ScoreProject,
  selection: RepairSelection,
  range: ReturnType<typeof selectedRange>,
): string[] {
  const notes = project.parts.filter((part) => range.partIds.has(part.id)).flatMap((part) => part.notes);
  const entering = notes.filter(
    (note) => note.start < range.start && note.start + note.duration > range.start + EPSILON,
  ).length;
  const leaving = notes.filter(
    (note) =>
      note.start >= range.start && note.start < range.end && note.start + note.duration > range.end + EPSILON,
  ).length;
  const warnings: string[] = [];
  if (entering)
    warnings.push(
      `${entering} 个延音从选区之前进入第 ${selection.startMeasure} 小节；按起音位置选择，这些音符保持不变。`,
    );
  if (leaving)
    warnings.push(
      `${leaving} 个选中音符延伸到第 ${selection.endMeasure} 小节之后；选区按起音位置确定，请检查边界处的延音。`,
    );
  return warnings;
}

function complete(
  project: ScoreProject,
  changedNotes: number,
  warnings: string[],
  options: { audit?: boolean; metadataChanged?: boolean; transform?: string } = {},
): RepairResult {
  if (changedNotes || options.metadataChanged) {
    project.updatedAt = new Date().toISOString();
    if (options.transform) {
      const analysis = project.source.analysis ?? { transforms: [] };
      analysis.transforms = [...analysis.transforms, options.transform].slice(-1000);
      project.source.analysis = analysis;
    }
    if (project.arrangement && options.audit) {
      const inspection = inspectArrangement(project);
      project.arrangement.report.ranges = inspection.ranges;
      project.arrangement.report.warnings = [
        ...new Set([...project.arrangement.report.warnings, ...inspection.warnings]),
      ];
      warnings.push(...inspection.warnings);
    }
  }
  assertProject(project);
  return { project, changedNotes, warnings: [...new Set(warnings)] };
}

function markChanged(note: NoteEvent, acoustic: boolean): void {
  note.origin = 'manual';
  if (acoustic) delete note.confidence;
}

/** Selection is inclusive by measure and includes events whose onset is in it. */
export function transposeSelection(
  project: ScoreProject,
  selection: RepairSelection,
  semitones: number,
): RepairResult {
  const range = selectedRange(project, selection);
  if (!Number.isInteger(semitones) || Math.abs(semitones) > 24)
    throw new Error('局部移调范围为正负 24 个整数半音。');
  const next = structuredClone(project);
  if (!semitones) return { project: next, changedNotes: 0, warnings: [] };
  const warnings = crossingWarnings(project, selection, range);
  let changedNotes = 0;
  for (const part of next.parts) {
    if (!range.partIds.has(part.id)) continue;
    if (part.role === 'percussion') {
      warnings.push('无固定音高的打击乐保持不变，不对 GM 鼓组音符做移调。');
      continue;
    }
    for (const note of part.notes) {
      if (note.midi === null || !range.contains(part.id, note)) continue;
      const pitch = note.midi + semitones;
      if (pitch < 0 || pitch > 127) throw new Error('移调将超出 MIDI 音高范围；未截断或修改原乐谱。');
      note.midi = pitch;
      markChanged(note, true);
      changedNotes++;
    }
    if (part.staves?.length) warnings.push(`${part.name} 的高低音谱表归属保持不变；移调后可重新设置谱表。`);
  }
  const pitchedParts = project.parts.filter((part) => part.role !== 'percussion');
  const wholeScore =
    pitchedParts.length > 0 &&
    selection.startMeasure === 1 &&
    selection.endMeasure === project.measures &&
    pitchedParts.every((part) => range.partIds.has(part.id));
  let metadataChanged = false;
  if (wholeScore && (changedNotes || next.chords.length)) {
    next.key = transposeKey(project.key, semitones);
    next.chords = next.chords.map((chord) => {
      const pitches = chord.pitches.map((pitch) => pitch + semitones);
      if (pitches.some((pitch) => pitch < 0 || pitch > 127))
        throw new Error('移调将让和弦超出 MIDI 音高范围；原乐谱保持不变。');
      const result = { ...chord, pitches, symbol: transposeChordSymbol(chord.symbol, semitones) };
      delete result.confidence;
      return result;
    });
    metadataChanged = true;
  } else if (changedNotes) warnings.push('局部移调不更改全曲调号或全局和弦；请自行核对这一段的和声。');
  if (changedNotes && project.originalAudio) warnings.push('原音频未变调；移调后的谱曲与原音频音高不同。');
  return complete(next, changedNotes, warnings, { audit: true, metadataChanged });
}

/** step is in quarter-note beats: 1, 1/2, 1/4 or their triplet divisions. */
export function quantizeSelection(
  project: ScoreProject,
  selection: RepairSelection,
  step: number,
): RepairResult {
  const range = selectedRange(project, selection);
  const grid = SUPPORTED_QUANTIZE_STEPS.find(
    (value) => Number.isFinite(step) && Math.abs(value - step) < EPSILON,
  );
  if (!grid) throw new Error('请选择四分、八分、十六分音符或对应三连音网格。');
  const next = structuredClone(project);
  const warnings = crossingWarnings(project, selection, range);
  let changedNotes = 0;
  const span = range.end - range.start;
  const lastGridIndex = Math.max(0, Math.ceil(span / grid - EPSILON) - 1);
  for (const part of next.parts) {
    const beforeCount = changedNotes;
    for (const note of part.notes) {
      if (!range.contains(part.id, note)) continue;
      const oldStart = note.start;
      const oldEnd = note.start + note.duration;
      const startIndex = Math.max(0, Math.min(lastGridIndex, Math.round((oldStart - range.start) / grid)));
      const start = range.start + startIndex * grid;
      const end =
        oldEnd > range.end + EPSILON
          ? oldEnd
          : Math.min(
              range.end,
              Math.max(start + grid, range.start + Math.round((oldEnd - range.start) / grid) * grid),
            );
      const duration = end - start;
      if (Math.abs(oldStart - start) <= EPSILON && Math.abs(note.duration - duration) <= EPSILON) continue;
      note.start = start;
      note.duration = duration;
      markChanged(note, true);
      changedNotes++;
    }
    if (changedNotes > beforeCount)
      part.notes.sort((a, b) => a.start - b.start || (b.midi ?? -1) - (a.midi ?? -1));
  }
  if (changedNotes) {
    warnings.push('量化对齐所选音符的起止拍点，不改变音高、删除音符或自动解决重叠；人工确认后再应用。');
    if (project.originalAudio) warnings.push('原音频的微时值保持不变，量化后的谱曲可能与其略有偏移。');
  }
  return complete(next, changedNotes, warnings, { audit: true });
}

export function setPartStaffLayout(
  project: ScoreProject,
  partId: string,
  layout: StaffLayout,
  splitPitch = 60,
): RepairResult {
  assertProject(project);
  if (!['auto', 'treble', 'bass', 'grand'].includes(layout)) throw new Error('谱表布局无效。');
  if (!Number.isInteger(splitPitch) || splitPitch < 0 || splitPitch > 127)
    throw new Error('高低音谱表分界应为 0–127 的 MIDI 音高。');
  const next = structuredClone(project);
  const part = next.parts.find((part) => part.id === partId);
  if (!part) throw new Error('所选声部不存在。');
  if (part.role === 'percussion' && layout !== 'auto')
    throw new Error('无固定音高打击乐应保留打击乐谱号，不能直接改为钢琴高低音谱表。');
  const prior = JSON.stringify({ clef: part.clef, staves: part.staves });
  if (layout === 'auto') delete part.staves;
  else if (layout === 'grand') {
    part.clef = 'treble';
    part.staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
  } else {
    part.clef = layout;
    part.staves = [{ number: 1, clef: layout }];
  }
  let changedNotes = 0;
  for (const note of part.notes) {
    const staff =
      layout === 'auto'
        ? undefined
        : layout === 'grand' && note.midi !== null && note.midi < splitPitch
          ? 2
          : 1;
    if (note.staff === staff) continue;
    if (staff === undefined) delete note.staff;
    else note.staff = staff;
    markChanged(note, false);
    changedNotes++;
  }
  const metadataChanged = prior !== JSON.stringify({ clef: part.clef, staves: part.staves });
  const warnings =
    changedNotes || metadataChanged
      ? [
          layout === 'auto'
            ? '已清除该声部的固定谱表编号，由阅谱引擎重新自动布局；音高、时值、原始声部标记和模型分不变。'
            : '仅改变谱表与高低音分配；音高、时值、原始声部标记、模型分及播放音色均不变。',
        ]
      : [];
  return complete(next, changedNotes, warnings, { metadataChanged });
}

/** Whitespace separates rehearsal syllables; no speech/lyric recognition is done. */
export function applyPartLyrics(
  project: ScoreProject,
  partId: string,
  startMeasure: number,
  endMeasure: number,
  text: string,
): RepairResult {
  const selection = { partIds: [partId], startMeasure, endMeasure };
  const range = selectedRange(project, selection);
  if (typeof text !== 'string' || text.length > 200_000)
    throw new Error('歌词应为不超过 200,000 字符的文字。');
  const tokens = text.trim() ? text.trim().split(/\s+/) : [];
  if (tokens.some((token) => token.length > 10_000)) throw new Error('单个歌词音节过长；请用空格划分音节。');
  const next = structuredClone(project);
  const part = next.parts.find((part) => part.id === partId)!;
  const groups = new Map<number, NoteEvent[]>();
  for (const note of part.notes) {
    if (note.midi === null || !range.contains(partId, note)) continue;
    if (!groups.has(note.start)) groups.set(note.start, []);
    groups.get(note.start)!.push(note);
  }
  const representatives = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, notes]) => [...notes].sort((a, b) => b.midi! - a.midi!)[0]);
  const warnings = crossingWarnings(project, selection, range);
  const additional = [...groups.values()].reduce((sum, notes) => sum + Math.max(0, notes.length - 1), 0);
  if (additional)
    warnings.push(`存在同步和弦：每个起音只给最高音写歌词，其余 ${additional} 个音符的歌词保持不变。`);
  if (!tokens.length)
    return { project: next, changedNotes: 0, warnings: [...warnings, '没有输入音节；不会清空原有歌词。'] };
  let changedNotes = 0;
  const count = Math.min(tokens.length, representatives.length);
  for (let index = 0; index < count; index++) {
    const note = representatives[index];
    if (note.lyric === tokens[index]) continue;
    note.lyric = tokens[index];
    markChanged(note, false);
    changedNotes++;
  }
  if (tokens.length > representatives.length)
    warnings.push(
      `${tokens.length - representatives.length} 个多余音节没有对应起音，未写入；请减少文字或扩大选区。`,
    );
  if (tokens.length < representatives.length)
    warnings.push(
      `音节少于起音数，剩余 ${representatives.length - tokens.length} 个音符的原有歌词保持不变。`,
    );
  warnings.push('按空格划分人工提供的音节；未进行自动歌词识别、翻译或拆字。');
  return complete(next, changedNotes, warnings);
}

/** Changes beat-coordinate interpretation, not tempo in physical seconds. */
export function reinterpretBeatUnit(project: ScoreProject, factor: 0.5 | 2): RepairResult {
  assertProject(project);
  if (factor !== 0.5 && factor !== 2) throw new Error('拍点重解释仅支持半速或倍速单位。');
  const tempo = project.tempo * factor;
  const originalTempo = (project.originalAudio?.tempo ?? project.tempo) * factor;
  if (tempo < 10 || tempo > 500 || (project.originalAudio && (originalTempo < 10 || originalTempo > 500)))
    throw new Error('重解释后的速度超出 10–500 BPM 范围，原乐谱保持不变。');
  const next = structuredClone(project);
  const barLength = beatsPerBar(project);
  const previousTotal = project.measures * barLength;
  const scaledTotal = previousTotal * factor;
  next.tempo = tempo;
  next.measures = Math.max(1, Math.ceil(scaledTotal / barLength - EPSILON));
  if (next.measures > 2048) throw new Error('重解释后的乐谱超过 2048 小节上限。');
  let changedNotes = 0;
  for (const part of next.parts)
    for (const note of part.notes) {
      note.start *= factor;
      note.duration *= factor;
      markChanged(note, false);
      changedNotes++;
    }
  for (const chord of next.chords) {
    chord.start *= factor;
    chord.duration *= factor;
  }
  if (next.originalAudio) next.originalAudio.tempo = originalTempo;
  const warnings = [
    '拍点、时值及 BPM 同比例重解释，所有音符的实际起止秒数保持不变；这不是把音频加速或减速。',
  ];
  if (next.measures * barLength > scaledTotal + EPSILON)
    warnings.push('原有小节数不能整除新拍点单位，末尾补齐一小节的空白；实际音符及音频长度不变。');
  if (next.source.analysis?.rhythm)
    warnings.push('原始节拍检测记录保留作证据；本次人工拍点重解释记录在 transforms 中。');
  return complete(next, changedNotes, warnings, {
    metadataChanged: true,
    transform: `Manual beat-unit reinterpretation x${factor}: score BPM ${project.tempo} -> ${tempo}; note/chord beats scaled equally; physical seconds unchanged.`,
  });
}
