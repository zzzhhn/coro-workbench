import { test, expect } from '@playwright/test';
import { createDemoProject } from '../../src/lib/demo';

test('review follows section seeks and playback until the listener turns it off', async ({ page }) => {
  const score = createDemoProject();
  const root = '/review-follow-fixture/';
  const mix = Buffer.alloc(44 + 8000 * 160);
  mix.write('RIFF'); mix.writeUInt32LE(mix.length - 8, 4); mix.write('WAVEfmt ', 8);
  mix.writeUInt32LE(16, 16); mix.writeUInt16LE(1, 20); mix.writeUInt16LE(1, 22);
  mix.writeUInt32LE(8000, 24); mix.writeUInt32LE(16000, 28); mix.writeUInt16LE(2, 32);
  mix.writeUInt16LE(16, 34); mix.write('data', 36); mix.writeUInt32LE(mix.length - 44, 40);
  await page.route(url => url.pathname.startsWith(root), async route => {
    const url = route.request().url();
    if (url.endsWith('mix.m4a')) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), mix.length - 1) : mix.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav',
        headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${mix.length}` } : {}) },
        body: mix.subarray(start, end + 1) });
    }
    const json = url.endsWith('manifest.json')
      ? { roundId: 'follow', songs: [{ id: 'demo', title: 'Demo', versions: [{ label: 'A', dir: 'draft' }] }] }
      : score;
    await route.fulfill({ json });
  });
  await page.goto('/review/arrangements.html?manifest=' + root + 'manifest.json');
  const follow = page.getByRole('button', { name: '跟随播放' });
  const next = page.getByRole('button', { name: '下一行乐谱' });
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await next.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate(a => (a as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
  const area = page.getByRole('region', { name: '五线谱' });
  await expect.poll(() => area.evaluate(a => a.scrollTop)).toBeGreaterThan(0);
  await follow.click();
  const before = await area.evaluate(a => a.scrollTop);
  await audio.evaluate(a => { (a as HTMLAudioElement).currentTime = 0; });
  await expect(page.locator('#play-position')).toHaveText('第 1 小节 · 第 1 拍');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  expect(await area.evaluate(a => a.scrollTop)).toBe(before);
  await follow.click();
  await expect.poll(() => area.evaluate(a => a.scrollTop)).toBeLessThan(before);
});
