import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import ImportDialog from '../src/components/ImportDialog';
import { analyzeAudio } from '../src/lib/api';

test('opening audio import selects whole-song transcription before any file is chosen', () => {
  const html = renderToStaticMarkup(createElement(ImportDialog, {
    onClose() {},
    onDemo() {},
    async onImport() { return true; },
    async onWorkspace() { return true; },
  }));

  const modes = Array.from(html.matchAll(/<button\b([^>]*\brole="radio"[^>]*)>([\s\S]*?)<\/button>/g));
  expect(modes[0]?.[2]).toContain('多声部总谱');
  expect(modes.filter(([, attrs]) => attrs.includes('aria-checked="true"')).map((mode) => mode[2])).toEqual([
    expect.stringContaining('多声部总谱'),
  ]);
  expect(html).toMatch(/<option value="600" selected="">完整歌曲/);
  expect(html).toMatch(/<option value="auto" selected="">GAME Medium/);
  expect(html).toContain('歌词辅助');
});

test('multi upload transmits GAME selection and optional timed lyrics unchanged', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'new-job', status: 'queued' })));
  vi.stubGlobal('fetch', fetcher);
  try {
    await analyzeAudio(new File(['audio'], 'new-song.wav'), {
      mode: 'multi', maxSeconds: 600, decoder: 'game', quality: 'auto', lyricsLrc: '[00:02.00]你好',
    });
    const body = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(body.get('decoder')).toBe('game');
    expect(body.get('lyrics_lrc')).toBe('[00:02.00]你好');
    expect(body.get('mode')).toBe('multi');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('score recognition sends the chosen OMR engine, defaulting to auto', async () => {
  const { recognizeScore } = await import('../src/lib/api');
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'omr-job', status: 'queued' })));
  vi.stubGlobal('fetch', fetcher);
  try {
    await recognizeScore(new File(['%PDF-1.4'], 'score.pdf'), { firstPage: 1, readText: false });
    await recognizeScore(new File(['%PDF-1.4'], 'score.pdf'), { firstPage: 2, lastPage: 3, readText: true, engine: 'audiveris' });
    const bodies = fetcher.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].body as FormData);
    expect(bodies[0].get('engine')).toBe('auto');
    expect(bodies[0].get('text_layer')).toBe('true');
    expect(bodies[1].get('engine')).toBe('audiveris');
    expect(bodies[1].get('read_text')).toBe('true');
  } finally {
    vi.unstubAllGlobals();
  }
});
