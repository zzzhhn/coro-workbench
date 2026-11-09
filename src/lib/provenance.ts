import type { ScoreProject } from './types';

export const CURRENT_PIPELINE_GENERATION = 'v5';

export type PipelineStatus =
  | { kind: 'not-audio' }
  | { kind: 'current'; revision?: string | null }
  | { kind: 'legacy'; reason: string };

const LEGACY_ENGINES: Array<[RegExp, string]> = [
  [/Basic Pitch/i, 'Basic Pitch 分轨转写'],
  [/rosvot/i, 'ROSVOT 主唱'],
];

/** Which pipeline produced an audio transcription. Arrangements and imported
 * scores are not transcriptions and are never flagged. */
export function pipelineStatus(project: ScoreProject): PipelineStatus {
  if (project.source.kind !== 'audio') return { kind: 'not-audio' };
  const stamp = project.source.pipeline;
  if (stamp?.generation === CURRENT_PIPELINE_GENERATION) return { kind: 'current', revision: stamp.revision };
  if (stamp?.generation) return { kind: 'legacy', reason: `流水线 ${stamp.generation}` };
  const engine = project.source.engine ?? '';
  const decoder = String(project.source.analysis?.quality?.decoderProfile ?? '');
  const label = LEGACY_ENGINES.find(([pattern]) => pattern.test(engine) || pattern.test(decoder))?.[1];
  return { kind: 'legacy', reason: label ?? '旧版流水线' };
}
