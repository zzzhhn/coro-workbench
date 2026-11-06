import { createDemoProject } from '../src/lib/demo';
import {
  createProjectBundle,
  importProjectBundle,
  unpackProjectArchive,
  resolveLocalAsset,
  readOriginalFile,
} from '../src/lib/projectBundle';
import { encodeWav } from '../src/lib/audio';
import { strFromU8, zipSync } from 'fflate';

const button = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector('#status')!;
const results = document.querySelector('#results')!;
button.onclick = async () => {
  button.disabled = true;
  status.textContent = 'Running...';
  const checks: Array<{ name: string; pass: boolean; details?: unknown }> = [];
  const check = (name: string, pass: boolean, details?: unknown) => {
    checks.push({ name, pass, details });
    results.textContent = JSON.stringify(checks, null, 2);
    if (!pass) throw new Error(name);
  };
  try {
    const project = createDemoProject();
    const buffer = new AudioBuffer({ length: 4410, sampleRate: 44100, numberOfChannels: 1 });
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.2;
    const audio = new Blob([Uint8Array.from(encodeWav(buffer))], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(audio);
    const originalFile = new Uint8Array([73, 68, 51, 4, 0, 0, 11, 22, 33, 44]);
    const originalUrl = URL.createObjectURL(new Blob([originalFile], { type: 'application/octet-stream' }));
    project.originalAudio = {
      name: 'fixture.mp3',
      url: audioUrl,
      fileUrl: originalUrl,
      duration: 0.1,
      tempo: project.tempo,
      offsetSeconds: 0,
    };
    project.parts[0].stemUrl = audioUrl;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    const imageUrls: string[] = [];
    for (const color of ['#f0d0ba', '#a8c2dc']) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 120);
      const image = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), 'image/png'),
      );
      imageUrls.push(URL.createObjectURL(image));
    }
    project.source.pages = imageUrls;
    const arrangement = structuredClone(project);
    arrangement.id = 'bundle-arrangement';
    arrangement.title = 'Bundle fixture vocal';
    const bytes = await createProjectBundle(
      { source: project, arrangement, active: 'arrangement', savedAt: 'fixture' },
      true,
    );
    const unpacked = await unpackProjectArchive(bytes);
    const manifest = JSON.parse(strFromU8(unpacked['manifest.json']));
    check(
      'all_distinct_pages_and_deduplicated_audio',
      manifest.assets.length === 4 && Object.keys(unpacked).length === 5,
      manifest.assets.map((a: { path: string; bytes: number }) => [a.path, a.bytes]),
    );
    check(
      'every_asset_has_sha256',
      manifest.assets.every((a: { sha256: string }) => /^[a-f0-9]{64}$/.test(a.sha256)),
    );
    const restored = await importProjectBundle(new File([Uint8Array.from(bytes)], 'fixture.coro'));
    check(
      'source_and_arrangement_preserved',
      JSON.stringify(restored.source.parts.map((p) => p.notes)) ===
        JSON.stringify(project.parts.map((p) => p.notes)) &&
        restored.arrangement?.title === arrangement.title,
    );
    check(
      'references_restored_as_local_not_external',
      restored.source.originalAudio?.url.startsWith('local:') === true &&
        restored.source.parts[0].stemUrl?.startsWith('local:') === true &&
        restored.source.source.pages?.length === 2,
      {
        audio: restored.source.originalAudio?.url,
        stem: restored.source.parts[0].stemUrl,
        pages: restored.source.source.pages,
      },
    );
    const restoredFile = new Uint8Array(
      await (await readOriginalFile(restored.source.originalAudio!)).arrayBuffer(),
    );
    check(
      'original_upload_not_replaced_by_decoded_wav',
      restoredFile.length === originalFile.length &&
        restoredFile.every((value, index) => value === originalFile[index]),
    );
    const resolved = await resolveLocalAsset(restored.source.originalAudio!.url);
    const media = await (await fetch(resolved)).arrayBuffer();
    check(
      'restored_audio_exact_bytes',
      new Uint8Array(media).every((value, index) => value === encodeWav(buffer)[index]) &&
        media.byteLength === audio.size,
    );
    const badAsset = manifest.assets[0].path;
    unpacked[badAsset] = new Uint8Array(unpacked[badAsset]);
    unpacked[badAsset][0] ^= 1;
    const corrupted = zipSync(unpacked);
    let rejected = false;
    try {
      await importProjectBundle(new File([Uint8Array.from(corrupted)], 'corrupt.coro'));
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('校验失败');
    }
    check('equal_length_corruption_rejected', rejected);
    const pageUrl1 = await resolveLocalAsset(restored.source.source.pages![0]);
    const pageUrl2 = await resolveLocalAsset(restored.source.source.pages![1]);
    const a = new Uint8Array(await (await fetch(pageUrl1)).arrayBuffer()),
      b = new Uint8Array(await (await fetch(pageUrl2)).arrayBuffer());
    check(
      'distinct_page_bytes_survive',
      a.length !== b.length || a.some((value, index) => value !== b[index]),
    );
    URL.revokeObjectURL(audioUrl);
    URL.revokeObjectURL(originalUrl);
    imageUrls.forEach((url) => URL.revokeObjectURL(url));
    [resolved, pageUrl1, pageUrl2].forEach((url) => URL.revokeObjectURL(url));
    status.textContent = `PASS ${checks.length}/${checks.length}`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { scope: 'Production portable archive + IndexedDB on independent generated media', checks },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    link.download = 'coro-project-validation.json';
    link.textContent = 'Download project validation';
    document.body.append(link);
  } catch (error) {
    status.textContent = `FAIL: ${error instanceof Error ? error.message : error}`;
  } finally {
    button.disabled = false;
  }
};
