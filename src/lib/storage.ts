import type { ScoreProject } from './types';
import { validateProject } from './music';
import { decodeLocalState, encodeLocalState } from './localCodec';

const KEY = 'coro.session.v1';
const DATABASE = 'coro-local-audio';
const STORE = 'audio';
const LIBRARY_KEY = 'coro.library.v1';
const localAssetKeys = new Map<string, string>();

export function registerLocalAssetUrl(url: string, key: string): void {
  localAssetKeys.set(url, key);
}

export interface WorkspaceState {
  source: ScoreProject;
  arrangement?: ScoreProject;
  active: 'source' | 'arrangement';
  savedAt: string;
}

function safeProject(project: ScoreProject): ScoreProject {
  const next = structuredClone(project);
  if (next.originalAudio?.url.startsWith('blob:')) next.originalAudio.url = `local:${project.id}`;
  if (project.originalAudio && localAssetKeys.has(project.originalAudio.url))
    next.originalAudio!.url = `local:${localAssetKeys.get(project.originalAudio.url)}`;
  if (project.originalAudio?.fileUrl && localAssetKeys.has(project.originalAudio.fileUrl))
    next.originalAudio!.fileUrl = `local:${localAssetKeys.get(project.originalAudio.fileUrl)}`;
  for (const part of next.parts)
    if (part.stemUrl && localAssetKeys.has(part.stemUrl))
      part.stemUrl = `local:${localAssetKeys.get(part.stemUrl)}`;
  if (next.source.pages)
    next.source.pages = next.source.pages.map((url) =>
      localAssetKeys.has(url) ? `local:${localAssetKeys.get(url)}` : url,
    );
  return next;
}

export function saveWorkspace(state: WorkspaceState): void {
  localStorage.setItem(
    KEY,
    encodeLocalState({
      ...state,
      source: safeProject(state.source),
      arrangement: state.arrangement ? safeProject(state.arrangement) : undefined,
    }),
  );
}

export function archiveWorkspace(state: WorkspaceState): void {
  const existing = readLibrary().filter((item) => item.source.id !== state.source.id);
  existing.unshift({
    ...state,
    source: safeProject(state.source),
    arrangement: state.arrangement ? safeProject(state.arrangement) : undefined,
  });
  localStorage.setItem(LIBRARY_KEY, encodeLocalState(existing.slice(0, 12)));
}

export function readLibrary(): WorkspaceState[] {
  try {
    const raw = decodeLocalState(localStorage.getItem(LIBRARY_KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter((state) => state?.source?.version === 1 && Array.isArray(state.source.parts))
      : [];
  } catch {
    return [];
  }
}

export function readWorkspace(): WorkspaceState | undefined {
  const raw = localStorage.getItem(KEY);
  if (!raw) return undefined;
  try {
    const state = decodeLocalState(raw) as WorkspaceState;
    if (!state.source || !Array.isArray(state.source.parts) || state.source.version !== 1) return undefined;
    if (validateProject(state.source).length) return undefined;
    if (state.arrangement && validateProject(state.arrangement).length) return undefined;
    return state;
  } catch {
    return undefined;
  }
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('浏览器无法打开本地音频缓存。'));
  });
}

export async function saveLocalAudio(id: string, blob: Blob): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(blob, id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('本地音频缓存写入中断。'));
    });
  } finally {
    db.close();
  }
}

export async function getLocalAudio(id: string): Promise<Blob | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result as Blob | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function downloadFile(
  content: string | Uint8Array | Blob,
  filename: string,
  type = 'application/octet-stream',
): void {
  const blob =
    content instanceof Blob
      ? content
      : new Blob([typeof content === 'string' ? content : Uint8Array.from(content)], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

export function serializeProject(project: ScoreProject): string {
  return JSON.stringify(safeProject(project), null, 2);
}

export function parseProject(content: string): ScoreProject {
  if (content.length > 30_000_000) throw new Error('工程文件过大，请使用小于 30 MB 的 .coro.json 文件。');
  const project = JSON.parse(content) as ScoreProject;
  if (project?.version !== 1 || !Array.isArray(project.parts) || !Array.isArray(project.chords))
    throw new Error('这不是有效的 Coro 工程文件。');
  const errors = validateProject(project);
  if (errors.length) throw new Error(`工程数据无法读取：${errors.slice(0, 3).join('；')}`);
  if (project.originalAudio && !/^(\/api\/audio\/|local:)/.test(project.originalAudio.url)) {
    delete project.originalAudio;
    project.source.warnings.push('外部音频链接未自动加载。请重新导入本地音频。');
  }
  if (
    project.originalAudio?.fileUrl &&
    !/^(?:\/api\/source\/[a-f0-9]{32}$|local:)/.test(project.originalAudio.fileUrl)
  ) {
    delete project.originalAudio.fileUrl;
    project.source.warnings.push('外部原文件链接已移除；保留本地播放音频。');
  }
  for (const part of project.parts)
    if (part.stemUrl && !/^(?:\/api\/audio\/|local:)/.test(part.stemUrl)) delete part.stemUrl;
  if (project.source.pages)
    project.source.pages = project.source.pages.filter(
      (url) => /^\/api\/omr\/jobs\/[a-f0-9]{32}\/pages\/\d+$/.test(url) || url.startsWith('local:'),
    );
  if (
    project.source.analysis?.rawProjectUrl &&
    !/^\/api\/projects\/[a-f0-9]{32}\/raw$/.test(project.source.analysis.rawProjectUrl)
  )
    delete project.source.analysis.rawProjectUrl;
  return project;
}
