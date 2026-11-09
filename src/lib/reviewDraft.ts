import type { NoteEvent, ScoreProject } from './types';
import { databaseRequest } from './projectDatabase';
import { safeProject } from './storage';
import type { PitchCoverageInterval } from './pitchReview';

export type ReviewStatus = 'pending' | 'confirmed' | 'modified' | 'uncertain';
export const reviewStatusLabels: Record<ReviewStatus, string> = {
  pending: '待听',
  confirmed: '已确认',
  modified: '已修改',
  uncertain: '暂不确定',
};
export interface ReviewSnapshot {
  notes: NoteEvent[];
  checkpoints: Record<string, ReviewStatus>;
}
export interface ReviewDraft {
  version: 1;
  base: ScoreProject;
  snapshot: ReviewSnapshot;
  past: ReviewSnapshot[];
  future: ReviewSnapshot[];
  position: { start: number; length: number; cursor: number; selected: string; coverageKey?: string };
  savedAt: string;
}

export function checkpointKey(interval: PitchCoverageInterval): string {
  return `${interval.kind}:${interval.startSeconds}:${interval.endSeconds}`;
}

export function newReviewDraft(project: ScoreProject, initialSeconds: number): ReviewDraft {
  const review = project.pitchReview;
  return {
    version: 1,
    base: safeProject(project),
    snapshot: {
      notes: structuredClone(project.parts.find((part) => part.id === 'vocals')?.notes ?? []),
      checkpoints: structuredClone(review?.checkpoints ?? {}),
    },
    past: [],
    future: [],
    position: {
      start: review?.start ?? Math.max(0, initialSeconds - 2),
      length: review?.length ?? 8,
      cursor: review?.cursor ?? initialSeconds,
      selected: '',
    },
    savedAt: new Date().toISOString(),
  };
}

// Compare the editable vocal timeline, not transient blob URLs or other parts.
export function reviewMatchesProject(record: ReviewDraft, project: ScoreProject): boolean {
  const signature = (p: ScoreProject) =>
    JSON.stringify([
      p.id,
      p.tempo,
      p.timeSignature,
      p.originalAudio?.tempo,
      p.originalAudio?.offsetSeconds,
      p.source.analysis?.rawProjectUrl,
      p.parts.find((part) => part.id === 'vocals')?.notes,
    ]);
  return signature(record.base) === signature(project);
}

export function reviewProject(record: ReviewDraft, project = record.base): ScoreProject {
  return {
    ...project,
    parts: project.parts.map((part) =>
      part.id === 'vocals' ? { ...part, notes: structuredClone(record.snapshot.notes) } : part,
    ),
    updatedAt: record.savedAt,
    pitchReview: {
      checkpoints: record.snapshot.checkpoints,
      start: record.position.start,
      length: record.position.length,
      cursor: record.position.cursor,
    },
  };
}

export function changeReview(record: ReviewDraft, snapshot: ReviewSnapshot): ReviewDraft {
  if (JSON.stringify(record.snapshot) === JSON.stringify(snapshot)) return record;
  return {
    ...record,
    snapshot,
    past: [...record.past, record.snapshot].slice(-40),
    future: [],
    savedAt: new Date().toISOString(),
  };
}
export function stepReview(record: ReviewDraft, direction: 'undo' | 'redo'): ReviewDraft {
  const from = direction === 'undo' ? record.past : record.future;
  const snapshot = from.at(-1);
  if (!snapshot) return record;
  return {
    ...record,
    snapshot,
    past: direction === 'undo' ? record.past.slice(0, -1) : [...record.past, record.snapshot].slice(-40),
    future:
      direction === 'redo' ? record.future.slice(0, -1) : [...record.future, record.snapshot].slice(-40),
    savedAt: new Date().toISOString(),
  };
}
export async function readReviewDraft(projectId: string): Promise<ReviewDraft | undefined> {
  const record = await databaseRequest<ReviewDraft | undefined>('drafts', 'readonly', (store) =>
    store.get(projectId),
  );
  if (
    record &&
    (record.version !== 1 ||
      !record.base ||
      !Array.isArray(record.snapshot?.notes) ||
      !Array.isArray(record.past) ||
      !Array.isArray(record.future))
  )
    throw new Error('校对草稿无法读取，原记录未被覆盖。');
  return record;
}
export async function saveReviewDraft(record: ReviewDraft): Promise<void> {
  await databaseRequest('drafts', 'readwrite', (store) => store.put(record, record.base.id));
}
export async function deleteReviewDraft(projectId: string): Promise<void> {
  await databaseRequest('drafts', 'readwrite', (store) => store.delete(projectId));
}
