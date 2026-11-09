import type { ScoreProject } from './types';
import { localAudioJobId } from './audioSource';

export const PENDING_VOCAL_REBUILD_KEY = 'coro.pending-vocal-rebuild.v1';
export type VocalInputChoice = 'current' | 'original-vocals' | 'enhanced-lead' | 'enhanced-vocals';
export type VocalRebuildDecoder = 'phoneme' | 'rosvot';
export const VOCAL_INPUT_LABELS: Record<VocalInputChoice, string> = {
  current: '当前已保存人声',
  'original-vocals': '原人声（含伴唱）',
  'enhanced-lead': '增强分离后的主唱',
  'enhanced-vocals': '增强人声（含伴唱）',
};

export interface PendingVocalRebuild {
  jobId: string;
  sourceId: string;
  title: string;
  beforeNotes: number;
  hadArrangement: boolean;
  vocalSource?: VocalInputChoice;
  decoder?: VocalRebuildDecoder;
}

export function vocalRebuildSourceId(project: ScoreProject): string | undefined {
  if (project.source.kind !== 'audio' || project.arrangement || !project.parts.some((part) => part.id === 'vocals'))
    return undefined;
  if (!/^\/api\/audio\/[a-f0-9]{32}\/original\.wav$/.test(project.originalAudio?.url ?? ''))
    return undefined;
  return localAudioJobId(project);
}

export function readPendingVocalRebuild(storage: Pick<Storage, 'getItem'>): PendingVocalRebuild | undefined {
  try {
    const value = JSON.parse(storage.getItem(PENDING_VOCAL_REBUILD_KEY) ?? 'null');
    if (!value || typeof value.jobId !== 'string' || !/^[a-f0-9]{32}$/.test(value.jobId) || typeof value.sourceId !== 'string' ||
        typeof value.title !== 'string' || value.title.length > 500 ||
        !Number.isInteger(value.beforeNotes) || value.beforeNotes < 0 || value.beforeNotes > 100_000 ||
        typeof value.hadArrangement !== 'boolean') return undefined;
    if (value.vocalSource !== undefined && !Object.hasOwn(VOCAL_INPUT_LABELS, value.vocalSource)) return undefined;
    if (value.decoder !== undefined && value.decoder !== 'phoneme' && value.decoder !== 'rosvot') return undefined;
    return value;
  } catch { return undefined; }
}
