import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { archiveWorkspace, readLibrary, deleteLibraryEntry, recordBundleExport, workspaceFingerprint } from '../src/lib/library';
import { createDemoProject } from '../src/lib/demo';
import { localAudioJobId } from '../src/lib/audioSource';
import {
  parseProject,
  readWorkspace,
  saveWorkspace,
  serializeProject,
  registerLocalAssetUrl,
} from '../src/lib/storage';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
function memoryStore() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  return store;
}

describe('local project preservation and import safety', () => {
  it('preserves the local GAME raw comparison across save and reload', () => {
    const project = createDemoProject();
    const id = 'a'.repeat(32);
    project.source.analysis = { transforms: [], rawProjectUrl: `/api/projects/${id}/game-raw` };
    const loaded = parseProject(serializeProject(project));
    expect(loaded.source.analysis?.rawProjectUrl).toBe(`/api/projects/${id}/game-raw`);
    expect(localAudioJobId(loaded)).toBe(id);
    project.source.analysis.rawProjectUrl = 'https://example.com/game-raw';
    expect(parseProject(serializeProject(project)).source.analysis?.rawProjectUrl).toBeUndefined();
  });
  it('removes ephemeral blob URLs from saved data without changing live project', () => {
    memoryStore();
    const project = createDemoProject();
    project.originalAudio = {
      name: 'demo.wav',
      url: 'blob:secret-local-handle',
      duration: 42,
      offsetSeconds: 0,
      tempo: 92,
    };
    saveWorkspace({ source: project, active: 'source', savedAt: 'now' });
    expect(readWorkspace()?.source.originalAudio?.url).toBe(`local:${project.id}`);
    expect(project.originalAudio.url).toBe('blob:secret-local-handle');
  });
  it('never automatically fetches a remote imported audio URL', () => {
    const project = createDemoProject();
    project.originalAudio = {
      name: 'remote.wav',
      url: 'https://example.com/private.wav',
      duration: 10,
      offsetSeconds: 0,
    };
    project.parts[0].stemUrl = 'https://example.com/track.wav';
    const loaded = parseProject(JSON.stringify(project));
    expect(loaded.originalAudio).toBeUndefined();
    expect(loaded.parts[0].stemUrl).toBeUndefined();
    expect(loaded.source.warnings.at(-1)).toContain('外部音频');
  });
  it('preserves a portable original file independently from decoded playback audio', () => {
    const project = createDemoProject();
    project.originalAudio = {
      name: 'song.mp3',
      url: 'local:decoded',
      fileUrl: 'blob:source-file',
      duration: 10,
      offsetSeconds: 0,
    };
    registerLocalAssetUrl('blob:source-file', 'original-bytes');
    const restored = parseProject(serializeProject(project));
    expect(restored.originalAudio?.fileUrl).toBe('local:original-bytes');
    expect(restored.originalAudio?.url).toBe('local:decoded');
    project.originalAudio.fileUrl = 'https://untrusted.invalid/song.mp3';
    expect(parseProject(JSON.stringify(project)).originalAudio?.fileUrl).toBeUndefined();
  });
  it('rejects malformed note metadata before it reaches the renderer', () => {
    const project = createDemoProject();
    (project.parts[0].notes[0] as unknown as { lyric: unknown }).lyric = { unexpected: true };
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  });

  it('rejects remote resource functions in imported color values', () => {
    const project = createDemoProject();
    project.parts[0].color = 'url(https://example.com/tracker.png)';
    expect(() => parseProject(JSON.stringify(project))).toThrow('颜色');
  });
  it('keeps the source and arrangement as separate archived documents', async () => {
    memoryStore();
    const source = createDemoProject();
    const arrangement = structuredClone(source);
    arrangement.id = 'new';
    arrangement.title = 'vocal';
    await archiveWorkspace({ source, arrangement, active: 'arrangement', savedAt: 'now' });
    const library = (await readLibrary()).map(entry => entry.workspace);
    expect(library).toHaveLength(1);
    expect(library[0].source.title).not.toBe(library[0].arrangement!.title);
    await archiveWorkspace({ source: { ...source, title: 'updated' }, active: 'source', savedAt: 'later' });
    expect(await readLibrary()).toHaveLength(1);
    expect((await readLibrary())[0].workspace.source.title).toBe('updated');
  });
  it('round-trips supported project information exactly', () => {
    const project = createDemoProject();
    expect(parseProject(serializeProject(project))).toEqual(project);
  });
  it('migrates a legacy library once and retains a compact active workspace', async () => {
    const store = memoryStore();
    const state = { source: createDemoProject(), active: 'source' as const, savedAt: 'old' };
    store.set('coro.session.v1', JSON.stringify(state));
    store.set('coro.library.v1', JSON.stringify([state]));
    expect(readWorkspace()).toEqual(state);
    expect((await readLibrary()).map(entry => entry.workspace)).toEqual([state]);
    saveWorkspace(state);
    await archiveWorkspace(state);
    expect(store.get('coro.session.v1')).toMatch(/^coro-z1:/);
    expect(store.has('coro.library.v1')).toBe(false);
    expect(readWorkspace()).toEqual(state);
    expect((await readLibrary()).map(entry => entry.workspace)).toEqual([state]);
  });
  it('saves a complete dense score when plain JSON would exceed the available quota', () => {
    const store = new Map<string, string>();
    const project = createDemoProject();
    for (const part of project.parts) for (const note of part.notes) note.lyric = 'rehearsal '.repeat(10);
    const state = { source: project, active: 'source' as const, savedAt: 'now' };
    expect(JSON.stringify(state).length).toBeGreaterThan(32_000);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > 32_000) throw new Error('QuotaExceededError');
        store.set(key, value);
      },
    });
    saveWorkspace(state);
    expect(readWorkspace()).toEqual(state);
  });
  it('retains more than twelve manually edited projects and immutable named versions', async () => {
    memoryStore();
    const source = createDemoProject();
    source.parts[0].notes[0].lyric = 'keep my edit';
    const first = { source, active: 'source' as const, savedAt: '2026-11-01' };
    await archiveWorkspace(first);
    const version = await archiveWorkspace(first, 'Before rehearsal');
    for (let i = 1; i <= 15; i++) await archiveWorkspace({ ...first, source: { ...source, id: `new-${i}` }, savedAt: `2026-11-${String(i + 1).padStart(2, '0')}` });
    expect(await readLibrary()).toHaveLength(17);
    expect((await readLibrary()).find(entry => entry.id === `project:${source.id}`)?.workspace.source.parts[0].notes[0].lyric).toBe('keep my edit');
    await archiveWorkspace({ ...first, source: { ...source, title: 'Changed' } });
    expect((await readLibrary()).find(entry => entry.id === version.id)?.workspace.source.title).toBe(source.title);
    await deleteLibraryEntry(version.id);
    expect(await readLibrary()).toHaveLength(16);
  });
  it('does not erase a corrupt legacy library or pretend migration succeeded', async () => {
    const memory = memoryStore();
    memory.set('coro.library.v1', '{broken');
    await expect(readLibrary()).rejects.toThrow();
    expect(memory.get('coro.library.v1')).toBe('{broken');
    const state = { source: createDemoProject(), active: 'source' as const, savedAt: 'now' };
    memory.set('coro.library.v1', JSON.stringify([state]));
    expect(await readLibrary()).toHaveLength(1);
  });
  it('records generated bundles without claiming future edits are backed up', async () => {
    memoryStore();
    const state = { source: createDemoProject(), active: 'source' as const, savedAt: 'now' };
    await recordBundleExport(state);
    expect((await readLibrary())[0].exportReceipt?.fingerprint).toBe(await workspaceFingerprint(state));
    state.source.parts[0].notes[0].midi = 62;
    await archiveWorkspace(state);
    expect((await readLibrary())[0].exportReceipt?.fingerprint).not.toBe(await workspaceFingerprint(state));
  });
});
