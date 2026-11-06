import { insertNote, modifyNote } from './editor';
import type { NoteEvent, ScoreProject } from './types';
import { jsonResponse } from './api';

export interface PitchFrame {
  seconds: number;
  fcpeMidi: number | null;
  crepeMidi: number | null;
  audible: boolean;
}

export interface PitchEvidence {
  jobId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  frameStepSeconds: number;
  frames: PitchFrame[];
  integrity: 'stored_file' | 'sha256_checked';
  method: string;
  groundTruthAvailable: false;
  note: string;
}

export type PitchCoverageKind = 'fcpe_missing' | 'fcpe_gated' | 'pitch_disagreement';
export interface PitchCoverageInterval {
  kind: PitchCoverageKind;
  startSeconds: number;
  endSeconds: number;
  supportSeconds: number;
  supportFraction: number;
}
export interface PitchCoverage {
  durationSeconds: number;
  totalIntervals: number;
  intervals: PitchCoverageInterval[];
  totalsSeconds: Record<PitchCoverageKind, number>;
  truncated: boolean;
  note: string;
  groundTruthAvailable: false;
}

export const pitchCoverageLabels: Record<PitchCoverageKind, string> = {
  fcpe_missing: '仅 CREPE 发声 · FCPE 无有效基频',
  fcpe_gated: '仅 CREPE 发声 · FCPE 低激活',
  pitch_disagreement: '两个模型音高相差大于半个八度',
};

export function coverageWindowStart(interval: PitchCoverageInterval, length: number, duration: number) {
  return Math.max(0, Math.min(Math.max(0, duration - length), interval.startSeconds - 1));
}

export async function getPitchCoverage(jobId: string, signal: AbortSignal): Promise<PitchCoverage> {
  return jsonResponse(await fetch(`/api/projects/${encodeURIComponent(jobId)}/pitch/coverage`, { signal }));
}

export function pitchEvidenceJobId(project: ScoreProject): string | undefined {
  return project.source.analysis?.rawProjectUrl?.match(/^\/api\/projects\/([a-f0-9]{32})\/raw$/)?.[1];
}

export function pitchBranchUrl(value: unknown): string | undefined {
  return typeof value === 'string' &&
    (/^\/api\/audio\/[a-f0-9]{32}\/stem-(?:lead|backing)\.wav$/.test(value) ||
      /^local:bundle-[a-f0-9-]+$/.test(value))
    ? value
    : undefined;
}

export function sourceSecond(project: ScoreProject, beat: number): number {
  return (
    (project.originalAudio?.offsetSeconds ?? 0) +
    (beat * 60) / (project.originalAudio?.tempo ?? project.tempo)
  );
}

export function sourceBeat(project: ScoreProject, seconds: number): number {
  return (
    ((seconds - (project.originalAudio?.offsetSeconds ?? 0)) *
      (project.originalAudio?.tempo ?? project.tempo)) /
    60
  );
}

export function sourceWindowNotes(project: ScoreProject, partId: string, start: number, end: number) {
  return (project.parts.find((part) => part.id === partId)?.notes ?? [])
    .filter(
      (note) =>
        note.midi !== null &&
        sourceSecond(project, note.start) < end &&
        sourceSecond(project, note.start + note.duration) > start,
    )
    .map((note) => ({
      note,
      startSeconds: sourceSecond(project, note.start),
      endSeconds: sourceSecond(project, note.start + note.duration),
    }));
}

export async function getPitchEvidence(
  jobId: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<PitchEvidence> {
  return jsonResponse(
    await fetch(`/api/projects/${encodeURIComponent(jobId)}/pitch?start=${start}&end=${end}`, { signal }),
  );
}

export function editNoteFromSourceTime(
  project: ScoreProject,
  partId: string,
  noteId: string,
  midi: number,
  startSeconds: number,
  endSeconds: number,
): ScoreProject {
  if (
    ![midi, startSeconds, endSeconds].every(Number.isFinite) ||
    !Number.isInteger(midi) ||
    midi < 0 ||
    midi > 127
  )
    throw new Error('音高需是0-127整数，起止时间必须有效。');
  const start = sourceBeat(project, startSeconds);
  const duration = sourceBeat(project, endSeconds) - start;
  if (start < -1e-7 || duration < 1 / 960) throw new Error('结束时间需晚于起音，且起音不能早于谱面开始。');
  const note = project.parts.find((part) => part.id === partId)?.notes.find((note) => note.id === noteId);
  if (!note || note.midi === null) throw new Error('请先选择一个有音高的音符。');
  return modifyNote(project, { partId, noteId }, { midi, start: Math.max(0, start), duration });
}

export function insertNoteFromSourceTime(
  project: ScoreProject,
  partId: string,
  midi: number,
  startSeconds: number,
  endSeconds: number,
) {
  if (
    ![midi, startSeconds, endSeconds].every(Number.isFinite) ||
    !Number.isInteger(midi) ||
    midi < 0 ||
    midi > 127
  )
    throw new Error('请填写有效的 MIDI 音高及原音频起止秒数。');
  const start = sourceBeat(project, startSeconds),
    duration = sourceBeat(project, endSeconds) - start;
  if (start < -1e-7 || duration < 1 / 960) throw new Error('新增音符需要有效起点和正时长。');
  return insertNote(project, partId, Math.max(0, start), duration, midi);
}

export function splitNoteAtSourceTime(
  project: ScoreProject,
  partId: string,
  noteId: string,
  seconds: number,
): ScoreProject {
  const note = project.parts.find((part) => part.id === partId)?.notes.find((note) => note.id === noteId);
  const at = Math.round(sourceBeat(project, seconds) * 960) / 960;
  if (
    !note ||
    note.midi === null ||
    !Number.isFinite(at) ||
    at - note.start < 1 / 960 ||
    note.start + note.duration - at < 1 / 960
  )
    throw new Error('请在选中音符内部放置游标，再拆分。');
  const next = structuredClone(project);
  const part = next.parts.find((part) => part.id === partId)!;
  const first = part.notes.find((item) => item.id === noteId)!;
  const second: NoteEvent = {
    ...first,
    id: crypto.randomUUID(),
    start: at,
    duration: first.start + first.duration - at,
    origin: 'manual',
    lyric: undefined,
    confidence: undefined,
  };
  first.duration = at - first.start;
  first.origin = 'manual';
  delete first.confidence;
  part.notes.push(second);
  part.notes.sort((a, b) => a.start - b.start);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function changedReviewNotes(original: ScoreProject, draft: ScoreProject, partId: string): number {
  const before = original.parts.find((part) => part.id === partId)?.notes ?? [];
  const after = draft.parts.find((part) => part.id === partId)?.notes ?? [];
  const originals = new Map(before.map((note) => [note.id, note]));
  return (
    after.filter((note) => JSON.stringify(note) !== JSON.stringify(originals.get(note.id))).length +
    before.filter((note) => !after.some((candidate) => candidate.id === note.id)).length
  );
}
