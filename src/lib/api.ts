import type { AnalysisJob, OmrJob, ScoreProject } from './types';
import { vocalRebuildSourceId, type VocalInputChoice, type VocalRebuildDecoder } from './vocalRebuild';

export interface EngineHealth {
  status: string;
  engines: Record<string, boolean | { ready?: boolean; available?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

export async function jsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('本地音频引擎没有响应。请用 npm start 启动完整工作台。');
  }
  if (!response.ok) {
    const detail = (data as { detail?: string | { message?: string }; error?: string }).detail;
    throw new Error(
      typeof detail === 'string'
        ? detail
        : (detail?.message ?? (data as { error?: string }).error ?? `请求失败 (${response.status})`),
    );
  }
  return data as T;
}

export async function getHealth(): Promise<EngineHealth> {
  return jsonResponse(await fetch('/api/health', { signal: AbortSignal.timeout(5000) }));
}

export async function analyzeAudio(
  file: File,
  options: {
    mode: 'quick' | 'separate' | 'multi';
    tempo?: number;
    maxSeconds: number;
    quality?: 'auto' | 'raw';
    decoder?: 'standard' | 'legato' | 'acoustic' | 'rosvot' | 'phoneme' | 'game';
    lyricsLrc?: string;
    verification?: 'full' | 'sampled';
  },
): Promise<AnalysisJob> {
  const data = new FormData();
  data.append('file', file);
  data.append('mode', options.mode);
  data.append('max_seconds', String(options.maxSeconds));
  if (options.quality) data.append('quality', options.quality);
  if (options.decoder) data.append('decoder', options.decoder);
  if (options.lyricsLrc?.trim()) data.append('lyrics_lrc', options.lyricsLrc);
  if (options.verification) data.append('verification', options.verification);
  if (options.tempo) data.append('tempo', String(options.tempo));
  return jsonResponse(await fetch('/api/analyze', { method: 'POST', body: data }));
}

export const getJob = async (id: string): Promise<AnalysisJob> =>
  jsonResponse(await fetch(`/api/jobs/${encodeURIComponent(id)}`));
export const cancelJob = async (id: string): Promise<AnalysisJob> =>
  jsonResponse(await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }));

export async function rebuildVocal(
  project: ScoreProject,
  vocalSource: VocalInputChoice = 'current',
  decoder?: VocalRebuildDecoder,
): Promise<AnalysisJob> {
  const jobId = vocalRebuildSourceId(project);
  if (!jobId) throw new Error('这份谱没有可复用的本机主唱音轨，请先导入音频并分轨。');
  return jsonResponse(await fetch(`/api/projects/${jobId}/vocal-rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, ...(vocalSource === 'current' ? {} : { vocalSource }), decoder }),
  }));
}

export type OmrEngine = 'auto' | 'homr' | 'audiveris';

export async function recognizeScore(
  file: File,
  options: { firstPage: number; lastPage?: number; readText: boolean; engine?: OmrEngine; textLayer?: boolean },
): Promise<OmrJob> {
  const data = new FormData();
  data.append('file', file);
  data.append('first_page', String(options.firstPage));
  if (options.lastPage) data.append('last_page', String(options.lastPage));
  data.append('read_text', String(options.readText));
  data.append('engine', options.engine ?? 'auto');
  data.append('text_layer', String(options.textLayer ?? false));
  return jsonResponse(await fetch('/api/omr', { method: 'POST', body: data }));
}
export const getOmrJob = async (id: string): Promise<OmrJob> =>
  jsonResponse(await fetch(`/api/omr/jobs/${encodeURIComponent(id)}`));
export const cancelOmrJob = async (id: string): Promise<OmrJob> =>
  jsonResponse(await fetch(`/api/omr/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }));
