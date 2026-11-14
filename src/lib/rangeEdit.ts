// Measure-range selection, copy/cut/paste and explicit notation voices 1-4.
//
// Interaction studied from Crescendo 11.30 (rubber band selects whole bars of
// the staves it crosses; paste asks "paste only / overwrite after / insert";
// voices 1-4 are a global entry state). Independent implementation over
// Coro's ScoreProject; see docs/CRESCENDO_INTERACTION_MAP.md.
import type { ChordEvent, NoteEvent, ScorePart, ScoreProject } from './types';
import { beatsPerBar } from './music';
import { editId, type Selection } from './editor';

const EPS = 1e-6;
const round = (beat: number) => Math.round(beat * 960) / 960;

/** Whole bars [startBar, endBar] (1-based, inclusive) of a contiguous run of parts. */
export interface RangeSelection {
  partIds: string[];
  startBar: number;
  endBar: number;
}

export interface Clip {
  bars: number;
  /** One entry per copied part, in score order; notes are relative to the clip start. */
  parts: Array<{ partId: string; notes: NoteEvent[] }>;
  /** Present only when the copy covered every part, since chords belong to the whole score. */
  chords?: ChordEvent[];
  barLength: number;
}

export const rangeBeats = (project: ScoreProject, range: RangeSelection) => {
  const bar = beatsPerBar(project);
  return { start: (range.startBar - 1) * bar, end: range.endBar * bar };
};

const barOf = (project: ScoreProject, beat: number) => Math.floor(beat / beatsPerBar(project) + EPS) + 1;

/** Parts between two parts (inclusive) in score order, limited to the visible ones. */
export function partSpan(project: ScoreProject, a: string, b: string, visible?: string[]): string[] {
  const order = project.parts.filter((part) => !visible || visible.includes(part.id)).map((part) => part.id);
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [a];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Range from an anchor note to another note (shift-click), in whole bars. */
export function rangeBetween(
  project: ScoreProject,
  anchor: Selection,
  other: Selection,
  visible?: string[],
): RangeSelection | undefined {
  const find = (selection: Selection) =>
    project.parts
      .find((part) => part.id === selection.partId)
      ?.notes.find((note) => note.id === selection.noteId);
  const a = find(anchor);
  const b = find(other);
  if (!a || !b) return undefined;
  const bars = [barOf(project, a.start), barOf(project, b.start)];
  return {
    partIds: partSpan(project, anchor.partId, other.partId, visible),
    startBar: Math.min(...bars),
    endBar: Math.max(...bars),
  };
}

/** Range covering every hit glyph (rubber band): the staves crossed and the bars touched. */
export function rangeFromHits(
  project: ScoreProject,
  hits: Array<{ partId: string; start: number }>,
  visible?: string[],
): RangeSelection | undefined {
  if (!hits.length) return undefined;
  const order = project.parts.filter((part) => !visible || visible.includes(part.id)).map((part) => part.id);
  const indices = hits.map((hit) => order.indexOf(hit.partId)).filter((index) => index >= 0);
  if (!indices.length) return undefined;
  const bars = hits.map((hit) => barOf(project, hit.start));
  return {
    partIds: order.slice(Math.min(...indices), Math.max(...indices) + 1),
    startBar: Math.min(...bars),
    endBar: Math.max(...bars),
  };
}

export function extendRange(project: ScoreProject, range: RangeSelection, bars: -1 | 1): RangeSelection {
  const endBar = Math.max(range.startBar, Math.min(project.measures, range.endBar + bars));
  return { ...range, endBar };
}

export const inRange = (project: ScoreProject, range: RangeSelection, partId: string, start: number) => {
  const { start: from, end } = rangeBeats(project, range);
  return range.partIds.includes(partId) && start >= from - EPS && start < end - EPS;
};

export function notesInRange(project: ScoreProject, range: RangeSelection): Selection[] {
  return project.parts
    .filter((part) => range.partIds.includes(part.id))
    .flatMap((part) =>
      part.notes
        .filter((note) => inRange(project, range, part.id, note.start))
        .map((note) => ({ partId: part.id, noteId: note.id })),
    );
}

/**
 * Copy notes that start inside the range. Lengths are clipped at the range end;
 * a note sounding in from an earlier bar is not copied (its attack is outside).
 */
export function copyRange(project: ScoreProject, range: RangeSelection): Clip {
  const { start, end } = rangeBeats(project, range);
  const parts = project.parts
    .filter((part) => range.partIds.includes(part.id))
    .map((part) => ({
      partId: part.id,
      notes: part.notes
        .filter((note) => note.start >= start - EPS && note.start < end - EPS)
        .map((note) => {
          const copy = structuredClone(note);
          copy.start = round(note.start - start);
          copy.duration = round(Math.min(note.duration, end - note.start));
          return copy;
        }),
    }));
  const allParts = project.parts.every((part) => range.partIds.includes(part.id));
  const chords = allParts
    ? project.chords
        .filter((chord) => chord.start >= start - EPS && chord.start < end - EPS)
        .map((chord) => ({
          ...chord,
          start: round(chord.start - start),
          duration: round(Math.min(chord.duration, end - chord.start)),
        }))
    : undefined;
  return { bars: range.endBar - range.startBar + 1, parts, chords, barLength: beatsPerBar(project) };
}

/** Remove notes (and, for a full-score range, chords) that start inside the range. */
export function clearRange(project: ScoreProject, range: RangeSelection): ScoreProject {
  const next = structuredClone(project);
  const { start, end } = rangeBeats(project, range);
  for (const part of next.parts)
    if (range.partIds.includes(part.id))
      part.notes = part.notes.filter((note) => !(note.start >= start - EPS && note.start < end - EPS));
  if (project.parts.every((part) => range.partIds.includes(part.id)))
    next.chords = next.chords.filter((chord) => !(chord.start >= start - EPS && chord.start < end - EPS));
  next.updatedAt = new Date().toISOString();
  return next;
}

/** A pasted note keeps pitch, rhythm, lyric and markings; it is new material, not the scan. */
function freshNote(note: NoteEvent, offset: number, target: ScorePart): NoteEvent {
  const copy: NoteEvent = {
    ...structuredClone(note),
    id: editId(),
    start: round(note.start + offset),
    origin: 'manual',
  };
  delete copy.sourceRef;
  delete copy.confidence;
  // The target may not have the source part's staff (e.g. grand staff -> single staff).
  if (!target.staves?.length) {
    delete copy.staff;
    // Lower-staff voices 5-8 become 1-4 on a single staff.
    if (copy.voice !== undefined) copy.voice = String(voiceNumber(copy) ?? 1);
  } else if (copy.staff !== undefined && !target.staves.some((staff) => staff.number === copy.staff))
    copy.staff = target.staves[0].number;
  return copy;
}

export type PasteMode = 'overwrite' | 'insert';

export interface PasteResult {
  project: ScoreProject;
  range: RangeSelection;
  warnings: string[];
}

/**
 * Paste a clip at the start of `bar` into `partId` and the parts after it.
 * overwrite: notes starting in the target bars are replaced and notes sounding
 * into them are shortened at the paste point; later bars stay where they are.
 * insert: every part (and chord) from the paste point on moves later by the
 * clip length, so the score stays aligned; then the clip fills the gap.
 */
export function pasteClip(
  project: ScoreProject,
  clip: Clip,
  partId: string,
  bar: number,
  mode: PasteMode,
  visible?: string[],
): PasteResult {
  const warnings: string[] = [];
  const barLength = beatsPerBar(project);
  if (Math.abs(barLength - clip.barLength) > EPS)
    warnings.push('复制处与粘贴处的拍号不同，按拍数粘贴，小节线位置可能不同。');
  const length = clip.bars * clip.barLength;
  const at = (bar - 1) * barLength;
  const end = at + length;
  const next = structuredClone(project);
  const order = next.parts.filter((part) => !visible || visible.includes(part.id));
  const first = order.findIndex((part) => part.id === partId);
  if (first < 0) throw new Error('请先选择要粘贴到的声部。');
  const targets = order.slice(first, first + clip.parts.length);
  if (targets.length < clip.parts.length)
    warnings.push(`剪贴板有 ${clip.parts.length} 个声部，下方只有 ${targets.length} 个，多出的声部未粘贴。`);

  if (mode === 'insert') {
    for (const part of next.parts) {
      const shifted: NoteEvent[] = [];
      for (const note of part.notes) {
        const finish = note.start + note.duration;
        if (note.start >= at - EPS) shifted.push({ ...note, start: round(note.start + length) });
        else if (finish > at + EPS) {
          // Split a note held across the insertion point; the tail continues after the gap.
          shifted.push({ ...note, duration: round(at - note.start) });
          const tail: NoteEvent = { ...note, id: editId(), start: round(end), duration: round(finish - at) };
          delete tail.lyric;
          delete tail.sourceRef;
          shifted.push(tail);
        } else shifted.push(note);
      }
      part.notes = shifted;
    }
    next.chords = next.chords.flatMap((chord) => {
      const finish = chord.start + chord.duration;
      if (chord.start >= at - EPS) return [{ ...chord, start: round(chord.start + length) }];
      if (finish > at + EPS)
        return [
          { ...chord, duration: round(at - chord.start) },
          { ...chord, start: round(end), duration: round(finish - at) },
        ];
      return [chord];
    });
    next.measures += clip.bars;
    if (next.originalAudio) warnings.push('插入小节后，乐谱时间线与原音频不再逐拍对应；原音频保持不变。');
  } else {
    for (const part of targets) {
      part.notes = part.notes
        .filter((note) => !(note.start >= at - EPS && note.start < end - EPS))
        .map((note) =>
          note.start < at && note.start + note.duration > at + EPS
            ? { ...note, duration: round(at - note.start) }
            : note,
        );
    }
    if (clip.chords)
      next.chords = next.chords
        .filter((chord) => !(chord.start >= at - EPS && chord.start < end - EPS))
        .map((chord) =>
          chord.start < at && chord.start + chord.duration > at + EPS
            ? { ...chord, duration: round(at - chord.start) }
            : chord,
        );
  }
  clip.parts.forEach((source, index) => {
    const target = targets[index];
    if (!target) return;
    target.notes.push(...source.notes.map((note) => freshNote(note, at, target)));
    target.notes.sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0));
  });
  if (clip.chords) {
    if (first !== 0 || targets.length !== next.parts.length)
      warnings.push('和弦标记属于整首谱，只在粘贴到全部声部时一起粘贴。');
    else {
      next.chords.push(...clip.chords.map((chord) => ({ ...chord, start: round(chord.start + at) })));
      next.chords.sort((a, b) => a.start - b.start);
    }
  }
  next.measures = Math.max(next.measures, bar - 1 + clip.bars);
  if (next.measures > 2048) throw new Error('工程最多支持 2048 小节。');
  next.updatedAt = new Date().toISOString();
  return {
    project: next,
    range: { partIds: targets.map((part) => part.id), startBar: bar, endBar: bar + clip.bars - 1 },
    warnings,
  };
}

// ---- Explicit notation voices 1-4 -------------------------------------------

/**
 * MusicXML numbers a grand staff's lower-staff voices 5-8. Show every staff's
 * voices as 1-4 and write back in the numbering that staff already uses.
 */
export function voiceNumber(note: NoteEvent): number | undefined {
  const value = Number(note.voice ?? '1');
  return Number.isInteger(value) && value >= 1 ? ((value - 1) % 4) + 1 : undefined;
}

function storedVoice(part: ScorePart, staff: number | undefined, voice: number): string {
  const sameStaff = part.notes.filter((note) => (note.staff ?? 1) === (staff ?? 1));
  const usesUpperBank = sameStaff.some((note) => Number(note.voice) >= 5 && Number(note.voice) <= 8);
  const lowerStaff = (staff ?? 1) > 1;
  return String(
    usesUpperBank || (lowerStaff && !sameStaff.some((note) => Number(note.voice) <= 4 && note.voice))
      ? voice + 4
      : voice,
  );
}

/** Move notes into notation voice 1-4 of their own staff. Pitch and rhythm unchanged. */
export function setVoice(project: ScoreProject, targets: Selection[], voice: 1 | 2 | 3 | 4): ScoreProject {
  const next = structuredClone(project);
  const wanted = new Set(targets.map((target) => `${target.partId}\0${target.noteId}`));
  let changed = false;
  for (const part of next.parts) {
    const original = project.parts.find((item) => item.id === part.id)!;
    const touched = new Set<number>();
    for (const note of part.notes)
      if (wanted.has(`${part.id}\0${note.id}`)) {
        touched.add(note.staff ?? 1);
        const value = storedVoice(original, note.staff, voice);
        if (note.voice !== value) {
          note.voice = value;
          changed = true;
        }
      }
    // Unnamed notes on a touched staff are implicitly voice 1; name them so the
    // engraver does not treat "" and "1" as two different voices.
    for (const note of part.notes)
      if (note.voice === undefined && touched.has(note.staff ?? 1) && changed)
        note.voice = storedVoice(original, note.staff, 1);
  }
  if (!changed) return project;
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Lane fields for a new note entered in voice N next to an existing note (or a part). */
export function voiceLane(part: ScorePart, staff: number | undefined, voice: 1 | 2 | 3 | 4) {
  return { staff, voice: storedVoice(part, staff, voice) };
}
