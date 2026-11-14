// Keyboard-first note entry and correction primitives.
//
// Interaction model studied from Crescendo 11.30 (menus, toolbox tooltips,
// official shortcut page and hands-on use; see docs/CRESCENDO_INTERACTION_MAP.md).
// Everything here is an independent Coro implementation over Coro's own
// ScoreProject model; no Crescendo code, assets or file formats are used.
import type { NoteEvent, ScoreProject } from './types';
import { beatsPerBar, normalizeKey } from './music';
import { editId, type Selection } from './editor';

/** Crescendo's number-key ladder: 1 whole ... 7 sixty-fourth (in quarter beats). */
export const DURATION_KEYS: Record<string, number> = {
  '1': 4,
  '2': 2,
  '3': 1,
  '4': 0.5,
  '5': 0.25,
  '6': 0.125,
  '7': 0.0625,
};

const EPS = 1e-6;
const round = (beat: number) => Math.round(beat * 960) / 960;
const NAMES: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};
const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const isFlatKey = (key: string) => /^(F|Bb|Eb|Ab|Db|Gb|Cb|Dm|Gm|Cm|Fm|Bbm|Ebm|Abm)$/.test(normalizeKey(key));

/** Pitch classes of the project's key (natural minor for minor keys). */
export function scalePitchClasses(key: string): number[] {
  const normalized = normalizeKey(key);
  const minor = normalized.endsWith('m');
  const tonic = NAMES[normalized.replace(/m$/, '')] ?? 0;
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return steps.map((step) => (tonic + step) % 12);
}

const nearest = (pc: number, reference: number) => {
  const base = Math.floor(reference / 12) * 12 + pc;
  const options = [base - 12, base, base + 12].filter((m) => m >= 0 && m <= 127);
  // Ties go upward, so a tritone away is deterministic.
  return options.reduce((best, m) =>
    Math.abs(m - reference) < Math.abs(best - reference) ||
    (Math.abs(m - reference) === Math.abs(best - reference) && m > best)
      ? m
      : best,
  );
};

/**
 * Letter name -> pitch inside the key signature, in the octave nearest the
 * reference pitch. Typing F in G major gives F#, as the printed key implies.
 */
export function letterPitch(letter: string, key: string, reference: number): number {
  const natural = LETTERS[letter.toUpperCase()];
  if (natural === undefined) throw new Error(`未知音名：${letter}`);
  // A letter can only be altered in the key's own direction (F# in G, Bb in F,
  // E# in C#), never respelled as a neighbouring letter.
  const scale = scalePitchClasses(key);
  const altered = (natural + (isFlatKey(key) ? -1 : 1) + 12) % 12;
  const pc = scale.includes(natural) ? natural : scale.includes(altered) ? altered : natural;
  return nearest(pc, reference);
}

/** Move to the next scale degree up or down (Crescendo's Shift+arrow nudge is diatonic). */
export function diatonicStep(midi: number, key: string, direction: 1 | -1): number {
  const scale = scalePitchClasses(key);
  let next = midi;
  do next += direction;
  while (next >= 0 && next <= 127 && !scale.includes(((next % 12) + 12) % 12));
  return Math.max(0, Math.min(127, next));
}

export type Accidental = 'sharp' | 'flat' | 'natural' | 'double-sharp' | 'double-flat';
const ALTER: Record<Accidental, number> = {
  sharp: 1,
  flat: -1,
  natural: 0,
  'double-sharp': 2,
  'double-flat': -2,
};

/**
 * Re-apply an accidental to the written letter of a pitch. The letter is the
 * key-signature spelling Coro already uses for engraving (flat keys spell
 * black keys as flats), so G# in C becomes G after "natural" and Gb after "flat".
 */
export function applyAccidental(midi: number, key: string, accidental: Accidental): number {
  const flatKey = isFlatKey(key);
  const pc = ((midi % 12) + 12) % 12;
  const naturals = Object.values(LETTERS);
  let letterPc = pc;
  if (!naturals.includes(pc)) letterPc = flatKey ? pc + 1 : pc - 1;
  const base = midi - pc + letterPc;
  return Math.max(0, Math.min(127, base + ALTER[accidental]));
}

const laneOf = (note: NoteEvent) => `${note.staff ?? 1}:${note.voice ?? '1'}`;

/** Next/previous attack in the same part, skipping simultaneous chord tones. */
export function neighbourNote(
  project: ScoreProject,
  selection: Selection,
  direction: 1 | -1,
): Selection | undefined {
  const part = project.parts.find((item) => item.id === selection.partId);
  const current = part?.notes.find((note) => note.id === selection.noteId);
  if (!part || !current) return undefined;
  const lane = laneOf(current);
  const sameLane = part.notes.filter((note) => laneOf(note) === lane);
  const pool = sameLane.length > 1 ? sameLane : part.notes;
  const candidates = pool
    .filter((note) => (direction > 0 ? note.start > current.start + EPS : note.start < current.start - EPS))
    .sort((a, b) => direction * (a.start - b.start) || (b.midi ?? -1) - (a.midi ?? -1));
  return candidates[0] ? { partId: part.id, noteId: candidates[0].id } : undefined;
}

/**
 * Move to the note in the part above/below at a time anchor (default: the
 * selected onset). Prefers a note attacking at the anchor, then one sounding
 * through it, then the nearest attack. Callers keep the anchor across repeated
 * vertical moves so down-then-up returns to the same note.
 */
export function crossPartNote(
  project: ScoreProject,
  selection: Selection,
  direction: 1 | -1,
  visiblePartIds?: string[],
  anchorBeat?: number,
): Selection | undefined {
  const parts = project.parts.filter((part) => !visiblePartIds || visiblePartIds.includes(part.id));
  const index = parts.findIndex((part) => part.id === selection.partId);
  const current = parts[index]?.notes.find((note) => note.id === selection.noteId);
  if (index < 0 || !current) return undefined;
  const beat = anchorBeat ?? current.start;
  const highest = (notes: NoteEvent[]) => [...notes].sort((a, b) => (b.midi ?? -1) - (a.midi ?? -1))[0];
  for (let i = index + direction; i >= 0 && i < parts.length; i += direction) {
    const notes = parts[i].notes;
    if (!notes.length) continue;
    const choice =
      highest(notes.filter((note) => Math.abs(note.start - beat) < EPS)) ??
      highest(notes.filter((note) => note.start < beat && note.start + note.duration > beat + EPS)) ??
      [...notes].sort((a, b) => Math.abs(a.start - beat) - Math.abs(b.start - beat))[0];
    return { partId: parts[i].id, noteId: choice.id };
  }
  return undefined;
}

export interface DurationChange {
  project: ScoreProject;
  /** Following attacks in the same lane that the new length now overlaps. */
  overlaps: number;
}

function editNote(
  project: ScoreProject,
  selection: Selection,
  edit: (note: NoteEvent) => void,
): { next: ScoreProject; note: NoteEvent } | undefined {
  const next = structuredClone(project);
  const part = next.parts.find((item) => item.id === selection.partId);
  const note = part?.notes.find((item) => item.id === selection.noteId);
  if (!part || !note) return undefined;
  edit(note);
  note.origin = 'manual';
  next.measures = Math.max(next.measures, Math.ceil((note.start + note.duration - EPS) / beatsPerBar(next)));
  if (next.measures > 2048) throw new Error('工程最多支持 2048 小节。');
  part.notes.sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0));
  next.updatedAt = new Date().toISOString();
  return { next, note };
}

const overlapCount = (project: ScoreProject, selection: Selection) => {
  const part = project.parts.find((item) => item.id === selection.partId)!;
  const note = part.notes.find((item) => item.id === selection.noteId)!;
  const end = note.start + note.duration;
  return part.notes.filter(
    (other) =>
      other.id !== note.id &&
      laneOf(other) === laneOf(note) &&
      other.start > note.start + EPS &&
      other.start < end - EPS,
  ).length;
};

/**
 * Change written length in place. Like Crescendo, neighbours never move:
 * shortening leaves an implied rest; lengthening is allowed but reported,
 * so an OMR rhythm error is not silently pushed into later bars.
 */
export function setNoteDuration(
  project: ScoreProject,
  selection: Selection,
  duration: number,
): DurationChange {
  if (!(duration > 0)) throw new Error('时值必须大于 0。');
  const result = editNote(project, selection, (note) => {
    note.duration = round(duration);
    delete note.confidence;
  });
  if (!result) return { project, overlaps: 0 };
  return { project: result.next, overlaps: overlapCount(result.next, selection) };
}

/** Toggle one augmentation dot (x1.5) on the written value. */
export function toggleDot(project: ScoreProject, selection: Selection): DurationChange {
  const note = project.parts
    .find((item) => item.id === selection.partId)
    ?.notes.find((item) => item.id === selection.noteId);
  if (!note) return { project, overlaps: 0 };
  const plain = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
  const dotted = plain.find((value) => Math.abs(value * 1.5 - note.duration) < EPS);
  return setNoteDuration(project, selection, dotted ? dotted : note.duration * 1.5);
}

/** Toggle a 3:2 triplet value (x2/3) on the written value. */
export function toggleTriplet(project: ScoreProject, selection: Selection): DurationChange {
  const note = project.parts
    .find((item) => item.id === selection.partId)
    ?.notes.find((item) => item.id === selection.noteId);
  if (!note) return { project, overlaps: 0 };
  const plain = [4, 2, 1, 0.5, 0.25, 0.125, 0.0625];
  const triplet = plain.find((value) => Math.abs((value * 2) / 3 - note.duration) < EPS);
  return setNoteDuration(project, selection, triplet ?? (note.duration * 2) / 3);
}

/** Replace pitch (or make a rest) while keeping onset, length, lyric and lane. */
export function setNotePitch(project: ScoreProject, selection: Selection, midi: number | null): ScoreProject {
  const result = editNote(project, selection, (note) => {
    note.midi = midi === null ? null : Math.max(0, Math.min(127, Math.round(midi)));
    delete note.confidence;
  });
  return result?.next ?? project;
}

/**
 * Append after the selected note (or at a beat) in the same staff/voice lane:
 * the step-entry caret. Returns the new selection so typing can continue.
 */
export function appendNote(
  project: ScoreProject,
  partId: string,
  start: number,
  duration: number,
  midi: number | null,
  lane?: Pick<NoteEvent, 'staff' | 'voice'>,
): { project: ScoreProject; selection: Selection } {
  const next = structuredClone(project);
  const part = next.parts.find((item) => item.id === partId);
  if (!part) throw new Error('请先选择一个声部。');
  const note: NoteEvent = {
    id: editId(),
    midi: midi === null ? null : Math.max(0, Math.min(127, Math.round(midi))),
    start: round(Math.max(0, start)),
    duration: round(duration),
    velocity: 0.75,
    origin: 'manual',
    ...(lane?.staff !== undefined ? { staff: lane.staff } : {}),
    ...(lane?.voice !== undefined ? { voice: lane.voice } : {}),
  };
  part.notes.push(note);
  part.notes.sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0));
  next.measures = Math.max(next.measures, Math.ceil((note.start + note.duration - EPS) / beatsPerBar(next)));
  if (next.measures > 2048) throw new Error('工程最多支持 2048 小节。');
  next.updatedAt = new Date().toISOString();
  return { project: next, selection: { partId, noteId: note.id } };
}

export interface LyricStep {
  project: ScoreProject;
  /** Next pitched note to receive a syllable; undefined at the end of the part. */
  next?: Selection;
}

/**
 * Commit one syllable and advance, as Crescendo's lyric tool does with
 * Space/Tab (next note) and '-' (hyphenated syllable, next note).
 */
export function commitLyric(
  project: ScoreProject,
  selection: Selection,
  text: string,
  direction: 1 | -1 = 1,
): LyricStep {
  const clean = text
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 80);
  const before = project.parts
    .find((item) => item.id === selection.partId)
    ?.notes.find((item) => item.id === selection.noteId);
  let next = project;
  if (before && (before.lyric ?? '') !== clean) {
    next = structuredClone(project);
    const note = next.parts
      .find((item) => item.id === selection.partId)!
      .notes.find((item) => item.id === selection.noteId)!;
    if (clean) note.lyric = clean;
    else delete note.lyric;
    next.updatedAt = new Date().toISOString();
  }
  // Lyrics belong to sung attacks: skip rests and the lower tones of a chord.
  let cursor: Selection | undefined = selection;
  do cursor = neighbourNote(next, cursor, direction);
  while (
    cursor &&
    next.parts.find((item) => item.id === cursor!.partId)!.notes.find((item) => item.id === cursor!.noteId)!
      .midi === null
  );
  return { project: next, next: cursor };
}

export interface ReviewIssue {
  partId: string;
  noteId: string;
  measure: number;
  kind: 'overlap' | 'low-confidence';
  message: string;
}

/**
 * Items a proof-reader should visit, in score order: notes that start before
 * the previous note of the same staff/voice has ended (the usual footprint of
 * a misread OMR duration), then uncalibrated low-confidence notes.
 */
export function reviewIssues(project: ScoreProject): ReviewIssue[] {
  const bar = beatsPerBar(project);
  const issues: Array<ReviewIssue & { start: number; order: number }> = [];
  project.parts.forEach((part, order) => {
    const lanes = new Map<string, NoteEvent[]>();
    for (const note of part.notes) {
      const lane = lanes.get(laneOf(note)) ?? [];
      lane.push(note);
      lanes.set(laneOf(note), lane);
    }
    for (const notes of lanes.values()) {
      const sorted = [...notes].sort((a, b) => a.start - b.start);
      let held: NoteEvent | undefined;
      for (const note of sorted) {
        if (held && note.start > held.start + EPS && note.start < held.start + held.duration - EPS)
          issues.push({
            partId: part.id,
            noteId: note.id,
            measure: Math.floor(note.start / bar) + 1,
            kind: 'overlap',
            message: `前一音符尚未结束（重叠 ${+(held.start + held.duration - note.start).toFixed(3)} 拍）`,
            start: note.start,
            order,
          });
        if (!held || note.start + note.duration > held.start + held.duration) held = note;
      }
    }
    for (const note of part.notes)
      if (note.confidence !== undefined && note.confidence < 0.6)
        issues.push({
          partId: part.id,
          noteId: note.id,
          measure: Math.floor(note.start / bar) + 1,
          kind: 'low-confidence',
          message: `模型低置信（${Math.round(note.confidence * 100)} 分，未校准）`,
          start: note.start,
          order,
        });
  });
  return issues
    .sort((a, b) => a.start - b.start || a.order - b.order || (a.kind === 'overlap' ? -1 : 1))
    .map(({ start: _start, order: _order, ...issue }) => issue);
}

/** Cycle to the next/previous review issue after the current selection's beat. */
export function nextIssue(
  project: ScoreProject,
  issues: ReviewIssue[],
  selection: Selection | undefined,
  beat: number,
  direction: 1 | -1,
): ReviewIssue | undefined {
  if (!issues.length) return undefined;
  const startOf = (issue: Pick<ReviewIssue, 'partId' | 'noteId'>) =>
    project.parts.find((p) => p.id === issue.partId)?.notes.find((n) => n.id === issue.noteId)?.start ?? 0;
  const currentIndex = selection
    ? issues.findIndex((issue) => issue.partId === selection.partId && issue.noteId === selection.noteId)
    : -1;
  if (currentIndex >= 0) return issues[(currentIndex + direction + issues.length) % issues.length];
  const ahead =
    direction > 0
      ? issues.find((issue) => startOf(issue) >= beat - EPS)
      : [...issues].reverse().find((issue) => startOf(issue) <= beat + EPS);
  return ahead ?? issues[direction > 0 ? 0 : issues.length - 1];
}
