// Tuplet grouping and onset re-flow for proof-reading OMR rhythm.
//
// Crescendo's tuplet tool (help page, C-level evidence): pick the first and
// last note, a 3:2 triplet is created by default, the ratio can be changed.
// Coro stores no tuplet object: a note's written value is its duration in
// beats, and the engraver brackets runs of 2/3-valued notes. So "making a
// tuplet" here means: lay the chosen notes end to end across a span so they
// divide it evenly, and "re-onset" means re-flowing a run of notes so each
// starts where the previous one ends. Independent implementation.
import type { NoteEvent, ScoreProject } from './types';
import { beatsPerBar } from './music';
import type { Selection } from './editor';

const EPS = 1e-6;
const round = (beat: number) => Math.round(beat * 960) / 960;
const laneOf = (note: NoteEvent) => `${note.staff ?? 1}:${note.voice ?? '1'}`;

export interface TupletSpec {
  /** Notes played... */
  actual: number;
  /** ...in the time of this many notes of the same written value. */
  normal: number;
}

export const TUPLET_PRESETS: Array<TupletSpec & { label: string }> = [
  { actual: 3, normal: 2, label: '三连音 3:2' },
  { actual: 2, normal: 3, label: '二连音 2:3' },
  { actual: 5, normal: 4, label: '五连音 5:4' },
  { actual: 6, normal: 4, label: '六连音 6:4' },
];

export interface RhythmChange {
  project: ScoreProject;
  /** Notes whose onset or length changed. */
  changed: number;
  /** Ordered attack groups (chords count once) that were laid out. */
  attacks: number;
  warnings: string[];
}

/** Attack groups (chord tones together) of the chosen notes, in time order, all in one lane. */
function attackGroups(project: ScoreProject, targets: Selection[]) {
  const partId = targets[0]?.partId;
  if (!partId || targets.some((target) => target.partId !== partId))
    throw new Error('请在同一个声部内选择音符。');
  const part = project.parts.find((item) => item.id === partId);
  if (!part) throw new Error('找不到这个声部。');
  const chosen = targets
    .map((target) => part.notes.find((note) => note.id === target.noteId))
    .filter(Boolean) as NoteEvent[];
  if (!chosen.length) throw new Error('请先选择音符。');
  const lanes = new Set(chosen.map(laneOf));
  if (lanes.size > 1) throw new Error('所选音符分属不同谱表或声部；请在同一声部内操作。');
  const lane = [...lanes][0];
  // Include chord tones of a chosen attack: same lane, onset and length (the
  // engraver's chord rule). A different length at the same onset is another
  // rhythm (often the OMR overlap being fixed) and stays put unless chosen.
  const starts = [...new Set(chosen.map((note) => round(note.start)))].sort((a, b) => a - b);
  const chosenIds = new Set(chosen.map((note) => note.id));
  const groups = starts.map((start) => {
    const lead = chosen.find((note) => Math.abs(note.start - start) < EPS)!;
    return part.notes.filter(
      (note) =>
        laneOf(note) === lane &&
        Math.abs(note.start - start) < EPS &&
        (chosenIds.has(note.id) || Math.abs(note.duration - lead.duration) < EPS),
    );
  });
  return { part, lane, groups };
}

/**
 * Lay `count` attacks evenly across `normal` written units starting at the
 * first chosen attack. Unit = the written value of the first chosen note
 * (snapped to the plain value it would be outside the tuplet). Example: three
 * eighth notes misread as 0.5 each become 1/3 each, onsets 0, 1/3, 2/3.
 */
export function makeTuplet(
  project: ScoreProject,
  targets: Selection[],
  spec: TupletSpec = { actual: 3, normal: 2 },
): RhythmChange {
  const { part, lane, groups } = attackGroups(project, targets);
  const warnings: string[] = [];
  if (groups.length !== spec.actual)
    warnings.push(
      `选了 ${groups.length} 个起音，${spec.actual}:${spec.normal} 需要 ${spec.actual} 个；已按选中数量均分。`,
    );
  const plain = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
  const firstDuration = groups[0][0].duration;
  // A note already shortened to a tuplet value maps back to its plain value.
  const unit =
    plain.find((value) => Math.abs(value - firstDuration) < EPS) ??
    plain.find((value) => Math.abs((value * spec.normal) / spec.actual - firstDuration) < EPS) ??
    plain.reduce((best, value) =>
      Math.abs(value - firstDuration) < Math.abs(best - firstDuration) ? value : best,
    );
  const span = unit * spec.normal;
  const each = span / groups.length;
  const start = groups[0][0].start;
  const end = start + span;
  const next = structuredClone(project);
  const target = next.parts.find((item) => item.id === part.id)!;
  let changed = 0;
  groups.forEach((group, index) => {
    for (const original of group) {
      const note = target.notes.find((item) => item.id === original.id)!;
      const onset = round(start + index * each);
      const length = round(each);
      if (Math.abs(note.start - onset) > EPS || Math.abs(note.duration - length) > EPS) changed++;
      note.start = onset;
      note.duration = length;
      note.origin = 'manual';
      delete note.confidence;
    }
  });
  const chosenIds = new Set(groups.flat().map((note) => note.id));
  const collide = target.notes.filter(
    (note) =>
      !chosenIds.has(note.id) && laneOf(note) === lane && note.start > start + EPS && note.start < end - EPS,
  );
  if (collide.length) warnings.push(`${collide.length} 个未选中的音符落在连音范围内，未移动，已列入待校对。`);
  const bar = beatsPerBar(project);
  if (Math.floor(start / bar + EPS) !== Math.floor((end - EPS) / bar + EPS))
    warnings.push('连音跨过了小节线；谱面会按小节拆开并加延音线。');
  target.notes.sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0));
  next.measures = Math.max(next.measures, Math.ceil((end - EPS) / bar));
  next.updatedAt = new Date().toISOString();
  return { project: next, changed, attacks: groups.length, warnings };
}

/** Undo a tuplet: give each attack its plain written value, laid end to end. */
export function removeTuplet(project: ScoreProject, targets: Selection[]): RhythmChange {
  const { groups } = attackGroups(project, targets);
  const plain = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
  const ratios = [3 / 2, 2 / 3, 5 / 4, 6 / 4, 7 / 4];
  const lengths = groups.map((group) => {
    const duration = group[0].duration;
    for (const ratio of ratios) {
      const value = plain.find((candidate) => Math.abs(candidate / ratio - duration) < EPS);
      if (value) return value;
    }
    return duration;
  });
  return reflow(project, groups, groups[0][0].start, lengths, '已还原为普通时值');
}

/**
 * Re-onset: keep each chosen attack's length and make them follow each other
 * from `from` (default: the first chosen attack). Fixes OMR runs where every
 * onset drifted after one misread value.
 */
export function reflowOnsets(project: ScoreProject, targets: Selection[], from?: number): RhythmChange {
  const { groups } = attackGroups(project, targets);
  return reflow(
    project,
    groups,
    from ?? groups[0][0].start,
    groups.map((group) => group[0].duration),
    '已重排起拍',
  );
}

function reflow(
  project: ScoreProject,
  groups: NoteEvent[][],
  from: number,
  lengths: number[],
  _label: string,
): RhythmChange {
  const partId = project.parts.find((part) => part.notes.some((note) => note.id === groups[0][0].id))!.id;
  const lane = laneOf(groups[0][0]);
  const next = structuredClone(project);
  const target = next.parts.find((item) => item.id === partId)!;
  let cursor = from;
  let changed = 0;
  groups.forEach((group, index) => {
    for (const original of group) {
      const note = target.notes.find((item) => item.id === original.id)!;
      const onset = round(cursor);
      const length = round(lengths[index]);
      if (Math.abs(note.start - onset) > EPS || Math.abs(note.duration - length) > EPS) changed++;
      note.start = onset;
      note.duration = length;
      note.origin = 'manual';
      delete note.confidence;
    }
    cursor += lengths[index];
  });
  const chosen = new Set(groups.flat().map((note) => note.id));
  const end = cursor;
  const warnings: string[] = [];
  const collide = target.notes.filter(
    (note) =>
      !chosen.has(note.id) && laneOf(note) === lane && note.start > from + EPS && note.start < end - EPS,
  );
  if (collide.length) warnings.push(`${collide.length} 个未选中的音符落在重排范围内，未移动，已列入待校对。`);
  target.notes.sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0));
  const bar = beatsPerBar(project);
  next.measures = Math.max(next.measures, Math.ceil((end - EPS) / bar));
  if (next.measures > 2048) throw new Error('工程最多支持 2048 小节。');
  next.updatedAt = new Date().toISOString();
  return { project: next, changed, attacks: groups.length, warnings };
}

/** Selections for every attack between two notes of one lane (inclusive), for click-first/click-last. */
export function attacksBetween(project: ScoreProject, a: Selection, b: Selection): Selection[] {
  if (a.partId !== b.partId) return [a, b];
  const part = project.parts.find((item) => item.id === a.partId);
  const first = part?.notes.find((note) => note.id === a.noteId);
  const last = part?.notes.find((note) => note.id === b.noteId);
  if (!part || !first || !last) return [a];
  const lane = laneOf(first);
  const [from, to] = first.start <= last.start ? [first.start, last.start] : [last.start, first.start];
  const seen = new Set<number>();
  return part.notes
    .filter((note) => laneOf(note) === lane && note.start >= from - EPS && note.start <= to + EPS)
    .filter((note) => {
      const key = round(note.start);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((note) => ({ partId: part.id, noteId: note.id }));
}
