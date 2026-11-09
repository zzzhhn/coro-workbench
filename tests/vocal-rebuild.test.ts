import { describe, expect, it, vi } from 'vitest';
import { createDemoProject } from '../src/lib/demo';
import { rebuildVocal } from '../src/lib/api';
import { PENDING_VOCAL_REBUILD_KEY, readPendingVocalRebuild, vocalRebuildSourceId } from '../src/lib/vocalRebuild';

describe('existing-project vocal rebuild', () => {
  it('only offers rebuild for an original audio source linked to a local job', () => {
    const project = createDemoProject();
    expect(vocalRebuildSourceId(project)).toBeUndefined();
    const id = 'a'.repeat(32);
    project.source = { kind: 'audio', warnings: [], analysis: { transforms: [], rawProjectUrl: `/api/projects/${id}/raw` } };
    project.parts[0].id = 'vocals';
    project.originalAudio = { name: 'clip.wav', url: `/api/audio/${id}/original.wav`, duration: 12, offsetSeconds: 0 };
    expect(vocalRebuildSourceId(project)).toBe(id);
    project.source.analysis = { transforms: [], quality: { modelEvidenceUrl: `/api/projects/${id}/evidence` } };
    expect(vocalRebuildSourceId(project)).toBe(id);
    project.originalAudio.url = 'https://example.com/private.wav';
    expect(vocalRebuildSourceId(project)).toBeUndefined();
  });
  it('restores a pending job without overwriting the normal import task key', () => {
    const value = { jobId: 'b'.repeat(32), sourceId: 'old', title: 'Song', beforeNotes: 450, hadArrangement: true };
    let requested = '';
    const storage = { getItem: (key: string) => { requested = key; return JSON.stringify(value); } };
    expect(readPendingVocalRebuild(storage)).toEqual(value);
    expect(requested).toBe(PENDING_VOCAL_REBUILD_KEY);
  });
  it('retains an enhanced-input choice across reload without requiring it on old records', () => {
    const value = { jobId: 'b'.repeat(32), sourceId: 'old', title: 'Song', beforeNotes: 450, hadArrangement: false, vocalSource: 'enhanced-vocals', decoder: 'phoneme' };
    expect(readPendingVocalRebuild({ getItem: () => JSON.stringify(value) })?.vocalSource).toBe('enhanced-vocals');
    expect(readPendingVocalRebuild({ getItem: () => JSON.stringify(value) })?.decoder).toBe('phoneme');
    expect(readPendingVocalRebuild({ getItem: () => JSON.stringify({ ...value, vocalSource: 'remote' }) })).toBeUndefined();
    expect(readPendingVocalRebuild({ getItem: () => JSON.stringify({ ...value, decoder: 'remote' }) })).toBeUndefined();
  });
  it.each(['invalid', 'null', '{"jobId":"../../file"}', JSON.stringify({ jobId: 'b'.repeat(32), sourceId: 'old', title: 'Song', beforeNotes: -1, hadArrangement: true })])('ignores damaged pending state: %s', (raw) => {
    expect(readPendingVocalRebuild({ getItem: () => raw })).toBeUndefined();
  });
  it('submits the current edited snapshot rather than reloading the old server score', async () => {
    const project = createDemoProject();
    const id = 'a'.repeat(32);
    project.source = { kind: 'audio', warnings: [], analysis: { transforms: [], rawProjectUrl: `/api/projects/${id}/raw` } };
    project.parts[0].id = 'vocals';
    project.parts[1].notes[0].lyric = 'my edit';
    project.tempo = 70;
    project.originalAudio = { name: 'clip.wav', url: `/api/audio/${id}/original.wav`, duration: 12, offsetSeconds: 0, tempo: 120 };
    const before = structuredClone(project);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'b'.repeat(32), status: 'queued' }), { status: 202 }));
    try {
      await rebuildVocal(project, 'current', 'phoneme');
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(`/api/projects/${id}/vocal-rebuild`);
      expect(JSON.parse(options!.body as string)).toEqual({ project: before, decoder: 'phoneme' });
      expect(project).toEqual(before);
      await expect(rebuildVocal(createDemoProject())).rejects.toThrow('本机主唱音轨');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { fetchMock.mockRestore(); }
  });
});
