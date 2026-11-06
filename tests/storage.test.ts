import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoProject } from '../src/lib/demo';
import {
  archiveWorkspace,
  parseProject,
  readLibrary,
  readWorkspace,
  saveWorkspace,
  serializeProject,
  registerLocalAssetUrl,
} from '../src/lib/storage';

afterEach(() => vi.unstubAllGlobals());
function memoryStore() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  return store;
}

describe('local project preservation and import safety', () => {
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
  it('keeps the source and arrangement as separate archived documents', () => {
    memoryStore();
    const source = createDemoProject();
    const arrangement = structuredClone(source);
    arrangement.id = 'new';
    arrangement.title = 'vocal';
    archiveWorkspace({ source, arrangement, active: 'arrangement', savedAt: 'now' });
    const library = readLibrary();
    expect(library).toHaveLength(1);
    expect(library[0].source.title).not.toBe(library[0].arrangement!.title);
    archiveWorkspace({ source: { ...source, title: 'updated' }, active: 'source', savedAt: 'later' });
    expect(readLibrary()).toHaveLength(1);
    expect(readLibrary()[0].source.title).toBe('updated');
  });
  it('round-trips supported project information exactly', () => {
    const project = createDemoProject();
    expect(parseProject(serializeProject(project))).toEqual(project);
  });
  it('migrates a legacy workspace and recent library to compact storage', () => {
    const store = memoryStore();
    const state = { source: createDemoProject(), active: 'source' as const, savedAt: 'old' };
    store.set('coro.session.v1', JSON.stringify(state));
    store.set('coro.library.v1', JSON.stringify([state]));
    expect(readWorkspace()).toEqual(state);
    expect(readLibrary()).toEqual([state]);
    saveWorkspace(state);
    archiveWorkspace(state);
    expect(store.get('coro.session.v1')).toMatch(/^coro-z1:/);
    expect(store.get('coro.library.v1')).toMatch(/^coro-z1:/);
    expect(readWorkspace()).toEqual(state);
    expect(readLibrary()).toEqual([state]);
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
});
