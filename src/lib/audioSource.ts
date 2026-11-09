import type { ScoreProject } from './types';

// A local model job can have evidence even when its baseline score is empty.
// Portable projects deliberately omit both links, so never derive this from id.
export function localAudioJobId(project: ScoreProject): string | undefined {
  const analysis = project.source.analysis;
  const rawId = analysis?.rawProjectUrl?.match(/^\/api\/projects\/([a-f0-9]{32})\/(?:raw|game-raw)$/)?.[1];
  const evidenceUrl = analysis?.quality?.modelEvidenceUrl;
  return rawId ?? (typeof evidenceUrl === 'string'
    ? evidenceUrl.match(/^\/api\/projects\/([a-f0-9]{32})\/evidence$/)?.[1]
    : undefined);
}
