import type { NoteEvent, ScorePart, ScoreProject } from './types';
import { beatsPerBar, transposeChordSymbol, transposeKey } from './music';

export interface Selection {
  partId: string;
  noteId: string;
}
export const editId = () => crypto.randomUUID();

const safeBeat = (value: number, minimum: number) =>
  Number.isFinite(value) ? Math.max(minimum, Math.round(value * 960) / 960) : minimum;

function checkLength(project: ScoreProject): void {
  if (project.measures > 2048) throw new Error('工程最多支持 2048 小节。请缩短音符位置或时值。');
}

export function modifyNote(
  project: ScoreProject,
  selection: Selection,
  patch: Partial<NoteEvent>,
): ScoreProject {
  const next = structuredClone(project);
  const part = next.parts.find((p) => p.id === selection.partId);
  const note = part?.notes.find((n) => n.id === selection.noteId);
  if (!note) return project;
  Object.assign(note, patch, { origin: 'manual' });
  if (patch.midi !== undefined || patch.start !== undefined || patch.duration !== undefined)
    delete note.confidence;
  if (patch.midi !== undefined && note.midi !== null)
    note.midi = Math.max(0, Math.min(127, Number.isFinite(note.midi) ? Math.round(note.midi) : 60));
  if (patch.start !== undefined) note.start = safeBeat(note.start, 0);
  if (patch.duration !== undefined) note.duration = safeBeat(note.duration, 1 / 960);
  const total = next.measures * beatsPerBar(next);
  if (note.start + note.duration > total)
    next.measures = Math.ceil((note.start + note.duration) / beatsPerBar(next));
  checkLength(next);
  part!.notes.sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0));
  next.updatedAt = new Date().toISOString();
  return next;
}

export function insertNote(
  project: ScoreProject,
  partId: string,
  start: number,
  duration: number,
  midi: number | null,
): { project: ScoreProject; selection: Selection } {
  const next = structuredClone(project);
  const part = next.parts.find((p) => p.id === partId);
  if (!part) throw new Error('请先选择一个声部。');
  const note: NoteEvent = {
    id: editId(),
    midi: midi === null ? null : Math.max(0, Math.min(127, Number.isFinite(midi) ? Math.round(midi) : 60)),
    start: safeBeat(start, 0),
    duration: safeBeat(duration, 1 / 960),
    velocity: 0.75,
    origin: 'manual',
  };
  part.notes.push(note);
  part.notes.sort((a, b) => a.start - b.start);
  next.measures = Math.max(next.measures, Math.ceil((note.start + note.duration) / beatsPerBar(next)));
  checkLength(next);
  next.updatedAt = new Date().toISOString();
  return { project: next, selection: { partId, noteId: note.id } };
}

export function deleteNote(project: ScoreProject, selection: Selection): ScoreProject {
  const next = structuredClone(project);
  const part = next.parts.find((p) => p.id === selection.partId);
  if (part) part.notes = part.notes.filter((n) => n.id !== selection.noteId);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function transposeProject(project: ScoreProject, semitones: number): ScoreProject {
  if (!Number.isInteger(semitones) || Math.abs(semitones) > 24) throw new Error('移调范围为正负 24 个半音。');
  const next = structuredClone(project);
  for (const part of next.parts)
    if (part.role !== 'percussion') {
      for (const note of part.notes)
        if (note.midi !== null) {
          if (note.midi + semitones < 0 || note.midi + semitones > 127)
            throw new Error('移调会超出 MIDI 音高范围。原乐谱未改变。');
          note.midi += semitones;
        }
    }
  next.key = transposeKey(next.key, semitones);
  for (const chord of next.chords) {
    chord.pitches = chord.pitches.map((n) => {
      if (n + semitones < 0 || n + semitones > 127)
        throw new Error('移调会让和弦超出 MIDI 音高范围。原乐谱未改变。');
      return n + semitones;
    });
    chord.symbol = transposeChordSymbol(chord.symbol, semitones);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export function duplicateMeasure(project: ScoreProject, measure: number): ScoreProject {
  if (!Number.isInteger(measure) || measure < 1 || measure > project.measures)
    throw new Error('请选择工程中的有效小节。');
  const next = structuredClone(project);
  const length = beatsPerBar(project);
  const start = (measure - 1) * length;
  const end = measure * length;
  // Cut sustained events at the insertion point; duplicate the intersecting material,
  // including notes that entered this measure on a tie from the previous measure.
  for (const part of next.parts) {
    const result: NoteEvent[] = [];
    for (const note of part.notes) {
      const finish = note.start + note.duration;
      if (note.start >= end) result.push({ ...note, start: note.start + length });
      else if (finish > end) {
        result.push({ ...note, duration: end - note.start });
        result.push({ ...note, id: editId(), start: end + length, duration: finish - end, lyric: undefined });
      } else result.push(note);
      if (note.start < end && finish > start) {
        const clippedStart = Math.max(note.start, start);
        result.push({
          ...note,
          id: editId(),
          start: clippedStart + length,
          duration: Math.min(finish, end) - clippedStart,
          lyric: note.start < start ? undefined : note.lyric,
        });
      }
    }
    part.notes = result.sort((a, b) => a.start - b.start);
  }
  const chords: ScoreProject['chords'] = [];
  for (const chord of next.chords) {
    const finish = chord.start + chord.duration;
    if (chord.start >= end) chords.push({ ...chord, start: chord.start + length });
    else if (finish > end) {
      chords.push({ ...chord, duration: end - chord.start });
      chords.push({ ...chord, start: end + length, duration: finish - end });
    } else chords.push(chord);
    if (chord.start < end && finish > start) {
      const clippedStart = Math.max(chord.start, start);
      chords.push({ ...chord, start: clippedStart + length, duration: Math.min(finish, end) - clippedStart });
    }
  }
  next.chords = chords.sort((a, b) => a.start - b.start);
  next.measures++;
  checkLength(next);
  if (next.originalAudio)
    next.source.warnings = [
      ...next.source.warnings,
      '插入小节后，乐谱时间线与原音频不再逐拍对应；原音频保持不变。',
    ];
  next.updatedAt = new Date().toISOString();
  return next;
}

export function changePart(project: ScoreProject, partId: string, patch: Partial<ScorePart>): ScoreProject {
  return {
    ...project,
    parts: project.parts.map((part) =>
      part.id === partId
        ? { ...part, ...patch, ...(patch.role ? { roleSource: 'manual' as const } : {}) }
        : part,
    ),
    updatedAt: new Date().toISOString(),
  };
}
