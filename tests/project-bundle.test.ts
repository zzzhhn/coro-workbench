import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  assetDigest,
  createProjectBundle,
  importProjectBundle,
  unpackProjectArchive,
  originalFileUrl,
} from '../src/lib/projectBundle';
import { createDemoProject } from '../src/lib/demo';
import { projectFromOmr } from '../src/lib/import';
import { toMusicXml, validateProject } from '../src/lib/music';

afterEach(() => vi.unstubAllGlobals());

describe('portable project archives', () => {
  it('keeps source upload bytes separate from a decoded WAV and hashes both', async () => {
    const project = createDemoProject();
    const id = 'b'.repeat(32);
    project.originalAudio = {
      name: 'song.mp3',
      url: `/api/audio/${id}/original.wav`,
      duration: 1,
      offsetSeconds: 0,
    };
    expect(originalFileUrl(project.originalAudio)).toBe(`/api/source/${id}`);
    const original = new Uint8Array([73, 68, 51, 1, 2, 3]);
    const decoded = new Uint8Array([82, 73, 70, 70, 4, 5]);
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(url === `/api/source/${id}` ? original : decoded, {
          headers: { 'Content-Type': url === `/api/source/${id}` ? 'application/octet-stream' : 'audio/wav' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const bytes = await createProjectBundle({ source: project, active: 'source', savedAt: 'test' }, false);
    const files = await unpackProjectArchive(bytes);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest.assets).toHaveLength(2);
    const audio = manifest.workspace.source.originalAudio;
    expect(files[audio.fileUrl.slice(7)]).toEqual(original);
    expect(files[audio.url.slice(7)]).toEqual(decoded);
    expect(manifest.assets.every((asset: { sha256: string }) => /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(
      true,
    );
    expect(project.originalAudio.fileUrl).toBeUndefined();
  });
  it('roundtrips source and arrangement without local media or external network', async () => {
    const source = createDemoProject();
    const arrangement = structuredClone(source);
    arrangement.id = 'derived';
    arrangement.title = 'Voices';
    const workspace = { source, arrangement, active: 'arrangement' as const, savedAt: 'test' };
    const archive = await createProjectBundle(workspace, true);
    const restored = await importProjectBundle(new File([Uint8Array.from(archive)], 'song.coro'));
    expect(restored.source).toEqual(source);
    expect(restored.arrangement).toEqual(arrangement);
    expect(restored.active).toBe('arrangement');
  });
  it('rejects path traversal before writing assets', async () => {
    const archive = zipSync({ 'manifest.json': strToU8('{}'), '../outside.wav': new Uint8Array([1, 2]) });
    await expect(unpackProjectArchive(archive)).rejects.toThrow('不安全');
  });
  it('verifies media content, not merely its byte length', async () => {
    const project = createDemoProject();
    project.originalAudio = {
      name: 'sample.wav',
      url: 'bundle:assets/asset-1.wav',
      duration: 1,
      offsetSeconds: 0,
    };
    const original = new Uint8Array([1, 2, 3, 4]);
    const corrupted = new Uint8Array([4, 3, 2, 1]);
    const manifest = {
      format: 'coro-bundle',
      version: 1,
      workspace: { source: project, active: 'source', savedAt: 'test' },
      assets: [
        { path: 'assets/asset-1.wav', type: 'audio/wav', bytes: 4, sha256: await assetDigest(original) },
      ],
      omissions: [],
    };
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'assets/asset-1.wav': corrupted,
    });
    await expect(importProjectBundle(new File([Uint8Array.from(archive)], 'corrupted.coro'))).rejects.toThrow(
      '校验失败',
    );
  });
  it('rejects an unknown archive instead of creating an empty score', async () => {
    const archive = zipSync({ 'manifest.json': strToU8('null') });
    await expect(importProjectBundle(new File([Uint8Array.from(archive)], 'bad.coro'))).rejects.toThrow();
  });
  it('fails instead of silently omitting requested media', async () => {
    const project = createDemoProject();
    project.originalAudio = {
      name: 'song.wav',
      url: 'https://external.invalid/song.wav',
      duration: 30,
      offsetSeconds: 0,
    };
    await expect(
      createProjectBundle({ source: project, active: 'source', savedAt: 'test' }, false),
    ).rejects.toThrow('外部资源');
  });
});

describe('OMR source provenance', () => {
  it('imports actual XML with duplicate labels numbered, not invented instruments', () => {
    const demo = createDemoProject();
    for (const part of demo.parts) {
      part.name = 'Voice';
      part.shortName = 'V';
    }
    const xml = toMusicXml(demo);
    const result = projectFromOmr({
      id: 'a'.repeat(32),
      status: 'complete',
      progress: 100,
      stage: 'complete',
      message: 'done',
      musicxml: xml,
      source: { filename: 'my-score.pdf', engine: 'Audiveris test' },
      warnings: ['Review required'],
      pageUrls: [`/api/omr/jobs/${'a'.repeat(32)}/pages/1`],
    });
    expect(result.source.kind).toBe('omr');
    expect(result.parts.map((part) => part.name)).toEqual([
      '识谱声部 1',
      '识谱声部 2',
      '识谱声部 3',
      '识谱声部 4',
      '识谱声部 5',
    ]);
    expect(result.source.warnings).toContain('Review required');
    expect(result.parts.every((part) => part.notes.every((note) => note.origin === 'transcribed'))).toBe(
      true,
    );
    expect(validateProject(result)).toEqual([]);
  });
});
