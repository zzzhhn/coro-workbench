import { test, expect } from '@playwright/test';
import { createDemoProject } from '../../src/lib/demo';
import { reviewChoices } from '../../review/ratings';

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

test('anonymous comments resolve to the same score after a reviewer shuffle', async ({ page }) => {
  const root = '/review-blind-fixture/';
  const roundId = 'Private revision round';
  const variants = [{ label: 'A', dir: 'draft', identity: 'Old approach' }, { label: 'B', dir: 'candidate', identity: 'New approach' }];
  const manifest = {
    roundId,
    related: { label: 'Internal prior revision', manifest: 'prior.json' },
    songs: [{ id: 'test-song', title: 'Blind sample', issue: 'Identifying hint', versions: variants }],
  };
  const choices = (seed: string) => reviewChoices(roundId, 'test-song', variants, seed);
  const seed = 'first-reviewer';
  const first = choices(seed);
  const other = Array.from({ length: 30 }, (_, index) => `other-reviewer-${index}`)
    .find(candidate => choices(candidate)[0].ref !== first[0].ref)!;
  const seedKey = 'coro-human-review:reviewer:v1';
  const storageKey = `coro-human-review:${roundId}:test-song`;
  const versionRating = { readiness: 'light', favorite: 'Legacy preference', problem: '', estimatedEditMinutes: 2 };
  await page.addInitScript(({ seedKey, seed, storageKey, rating }) => {
    if (!localStorage.getItem(seedKey)) localStorage.setItem(seedKey, seed);
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(rating));
  }, { seedKey, seed, storageKey, rating: { roundId, songId: 'test-song', updatedAt: 'yesterday', preference: first[1].version.label, versions: { [first[1].version.label]: versionRating } } });
  const score = createDemoProject();
  await page.route(url => url.pathname.startsWith(root), route => route.request().url().endsWith('.m4a')
    ? route.fulfill({ status: 404 })
    : route.fulfill({ json: route.request().url().endsWith('manifest.json') ? manifest : score }));
  await page.goto('/review/arrangements.html?manifest=' + root + 'manifest.json');
  await expect(page.getByRole('radio', { name: 'Y', exact: true })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Y', exact: true }).getByRole('textbox', { name: '最喜欢的地方' })).toHaveValue('Legacy preference');
  await expect(page.locator('body')).not.toContainText(/Identifying hint|Private revision round|Internal prior revision|Old approach|New approach/);
  await page.locator('#part').selectOption('solo');
  await page.getByRole('button', { name: '下一行乐谱' }).click();
  await page.getByRole('group', { name: 'X', exact: true }).getByRole('textbox', { name: '最需要改的地方' }).fill('Change this entry');
  const mark = page.getByRole('link', { name: /X 最需要改的地方，Solo/ });
  const anchorUrl = await mark.getAttribute('href');
  expect(anchorUrl).toContain(`version=${first[0].ref}`);
  expect(anchorUrl).not.toContain(first[0].version.dir);
  await page.getByRole('radio', { name: '无偏好' }).check();
  await page.getByRole('group', { name: 'X', exact: true }).getByRole('combobox').selectOption('direct');
  await page.getByRole('group', { name: 'X', exact: true }).getByRole('spinbutton').fill('0');
  await page.getByRole('button', { name: '保存盲评' }).click();
  await expect(page.getByRole('button', { name: '查看版本说明' })).toBeVisible();
  await expect(page.getByText('Identifying hint')).toHaveCount(0);
  await page.getByRole('button', { name: '查看版本说明' }).click();
  await expect(page.getByText('Identifying hint')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Internal prior revision' })).toBeVisible();
  await page.evaluate(({ seedKey, other, storageKey }) => {
    localStorage.setItem(seedKey, other);
    localStorage.removeItem(storageKey);
  }, { seedKey, other, storageKey });
  await page.goto(anchorUrl!);
  await expect(page.getByRole('button', { name: 'Y', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#part')).toHaveValue('solo');
  await expect(page.locator('#play-position')).toHaveText(/第 [2-9]\d* 小节 · 第 1 拍/);
  await expect(page.getByText('Identifying hint')).toHaveCount(0);
});
