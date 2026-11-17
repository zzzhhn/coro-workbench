// Insert and delete whole measures across the score.
//
// Crescendo: Edit > 插入小节 / 添加栏 (⌘B append) and deleting selected bars
// (B/C-level evidence: menus and help page). Independent implementation over
// Coro's beat-based ScoreProject: every part, chord and pedal moves together
// so the score stays aligned.
import type { ChordEvent, NoteEvent, ScoreProject } from './types';
import { beatsPerBar } from './music';
import { editId } from './editor';
import { shiftLayout } from './layout';

const EPS = 1e-6;
const round = (beat: number) => Math.round(beat * 960) / 960;

export interface MeasureChange {
  project: ScoreProject;
  warnings: string[];
}

function audioWarning(project: ScoreProject, warnings: string[]) {
  if (project.originalAudio) warnings.push('增删小节后，乐谱时间线与原音频不再逐拍对应；原音频保持不变。');
}

/** Insert `count` empty bars before `bar` (1-based; bar = measures + 1 appends). */
export function insertMeasures(project: ScoreProject, bar: number, count = 1): MeasureChange {
  if (!Number.isInteger(bar) || bar < 1 || bar > project.measures + 1) throw new Error('插入位置无效。');
  if (!Number.isInteger(count) || count < 1) throw new Error('插入的小节数无效。');
  if (project.measures + count > 2048) throw new Error('工程最多支持 2048 小节。');
  const length = count * beatsPerBar(project);
  const at = (bar - 1) * beatsPerBar(project);
  const next = structuredClone(project);
  let split = 0;
  for (const part of next.parts) {
    const notes: NoteEvent[] = [];
    for (const note of part.notes) {
      const end = note.start + note.duration;
      if (note.start >= at - EPS) notes.push({ ...note, start: round(note.start + length) });
      else if (end > at + EPS) {
        // A note held across the insertion point: keep the attack, continue after the new bars.
        split++;
        notes.push({ ...note, duration: round(at - note.start) });
        // The tail keeps the sourceRef: it is the same printed note, so a click on it in the
        // source panel still finds the original bar.
        const tail: NoteEvent = {
          ...note,
          id: editId(),
          start: round(at + length),
          duration: round(end - at),
        };
        delete tail.lyric;
        notes.push(tail);
      } else notes.push(note);
    }
    part.notes = notes;
    for (const key of ['pedals', 'pedalSustain'] as const)
      part[key] = part[key]?.map((span) => ({
        start: span.start >= at - EPS ? round(span.start + length) : span.start,
        end: span.end > at + EPS ? round(span.end + length) : span.end,
      }));
  }
  next.chords = next.chords.flatMap((chord): ChordEvent[] => {
    const end = chord.start + chord.duration;
    if (chord.start >= at - EPS) return [{ ...chord, start: round(chord.start + length) }];
    if (end > at + EPS)
      return [
        { ...chord, duration: round(at - chord.start) },
        { ...chord, start: round(at + length), duration: round(end - at) },
      ];
    return [chord];
  });
  next.measures += count;
  next.updatedAt = new Date().toISOString();
  const shifted = shiftLayout(next, { at: bar, inserted: count });
  const warnings: string[] = [];
  if (split) warnings.push(`${split} 个跨插入点的长音被分成两段，新小节为空。`);
  audioWarning(project, warnings);
  return { project: shifted, warnings };
}

/**
 * Delete bars [startBar, endBar] in every part. Contents of those bars are
 * removed; a note held into them from earlier is cut at the deletion point;
 * everything after moves earlier. A note that starts inside and rings past the
 * deleted range is removed with its bar (reported).
 */
export function deleteMeasures(project: ScoreProject, startBar: number, endBar = startBar): MeasureChange {
  if (
    !Number.isInteger(startBar) ||
    !Number.isInteger(endBar) ||
    startBar < 1 ||
    endBar < startBar ||
    endBar > project.measures
  )
    throw new Error('请选择工程中的有效小节。');
  const count = endBar - startBar + 1;
  if (count >= project.measures) throw new Error('不能删除全部小节；至少保留一个小节。');
  const bar = beatsPerBar(project);
  const from = (startBar - 1) * bar;
  const to = endBar * bar;
  const length = to - from;
  const next = structuredClone(project);
  let removed = 0;
  let ringing = 0;
  let cut = 0;
  for (const part of next.parts) {
    const notes: NoteEvent[] = [];
    for (const note of part.notes) {
      const end = note.start + note.duration;
      if (note.start >= to - EPS) notes.push({ ...note, start: round(note.start - length) });
      else if (note.start >= from - EPS) {
        removed++;
        if (end > to + EPS) ringing++;
      } else if (end > from + EPS) {
        cut++;
        notes.push({ ...note, duration: round(from - note.start) });
      } else notes.push(note);
    }
    part.notes = notes;
    for (const key of ['pedals', 'pedalSustain'] as const)
      part[key] = part[key]?.flatMap((span) => {
        const clip = (beat: number) => (beat <= from ? beat : beat >= to ? beat - length : from);
        const start = round(clip(span.start));
        const end = round(clip(span.end));
        return end > start + EPS ? [{ start, end }] : [];
      });
  }
  next.chords = next.chords.flatMap((chord): ChordEvent[] => {
    const end = chord.start + chord.duration;
    if (chord.start >= to - EPS) return [{ ...chord, start: round(chord.start - length) }];
    if (chord.start >= from - EPS) return [];
    if (end > from + EPS) return [{ ...chord, duration: round(from - chord.start) }];
    return [chord];
  });
  next.measures -= count;
  next.updatedAt = new Date().toISOString();
  const shifted = shiftLayout(next, { from: startBar, to: endBar });
  const warnings: string[] = [];
  if (removed) warnings.push(`删除了 ${removed} 个音符/休止。`);
  if (ringing) warnings.push(`其中 ${ringing} 个从被删小节延续到后面的长音一并删除。`);
  if (cut) warnings.push(`${cut} 个延入被删小节的长音在删除处截短。`);
  audioWarning(project, warnings);
  return { project: shifted, warnings };
}
