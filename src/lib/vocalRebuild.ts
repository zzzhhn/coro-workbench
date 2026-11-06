import type { ScoreProject } from './types';

export const PENDING_VOCAL_REBUILD_KEY = 'coro.pending-vocal-rebuild.v1';

export interface PendingVocalRebuild {
  jobId: string;
  sourceId: string;
  title: string;
  beforeNotes: number;
  hadArrangement: boolean;
}

export function vocalRebuildSourceId(project: ScoreProject): string | undefined {
  if (project.source.kind !== 'audio' || project.arrangement || !project.parts.some((part) => part.id === 'vocals'))
    return undefined;
  if (!/^\/api\/audio\/[a-f0-9]{32}\/original\.wav$/.test(project.originalAudio?.url ?? ''))
    return undefined;
  return project.source.analysis?.rawProjectUrl?.match(/^\/api\/projects\/([a-f0-9]{32})\/raw$/)?.[1];
}

export function readPendingVocalRebuild(storage: Pick<Storage, 'getItem'>): PendingVocalRebuild | undefined {
  try {
    const value = JSON.parse(storage.getItem(PENDING_VOCAL_REBUILD_KEY) ?? 'null');
    if (!value || typeof value.jobId !== 'string' || !/^[a-f0-9]{32}$/.test(value.jobId) || typeof value.sourceId !== 'string' ||
        typeof value.title !== 'string' || value.title.length > 500 ||
        !Number.isInteger(value.beforeNotes) || value.beforeNotes < 0 || value.beforeNotes > 100_000 ||
        typeof value.hadArrangement !== 'boolean') return undefined;
    return value;
  } catch { return undefined; }
}
