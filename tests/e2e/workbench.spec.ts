import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

async function exportedProject(page: Page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('radio', { name: /^Coro 工程/ }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}

test('original -> vocal arrangement -> editable score -> MIDI export', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Blue Hour', exact: true })).toBeVisible();
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const originalNotes = await page.getByTestId('score-note').count();
  await page.getByRole('button', { name: /一键编成阿卡贝拉/ }).click();
  await page.getByRole('button', { name: '生成阿卡贝拉谱', exact: true }).click();
  await expect(page.getByRole('tab', { name: /阿卡贝拉/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('score-note').first().click();
  const originalPitch = await page.locator('.selected-pitch h3').textContent();
  await page.getByRole('button', { name: '升高半音', exact: true }).click();
  await expect(page.locator('.selected-pitch h3')).not.toHaveText(originalPitch!);
  await page.getByLabel('音符歌词', { exact: true }).fill('doo');
  await page.getByLabel('音符歌词', { exact: true }).press('Enter');
  await expect(page.getByLabel('音符歌词', { exact: true })).toHaveValue('doo');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('tab', { name: '原曲总谱', exact: true }).click();
  await expect(page.getByTestId('score-note')).toHaveCount(originalNotes);
  await page.getByRole('tab', { name: /阿卡贝拉/ }).click();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('radio', { name: /^MIDI / }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.mid$/);
  expect(errors).toEqual([]);
});

test('mobile app fits viewport with independent score scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '显示声部面板', exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    page: document.documentElement.scrollWidth,
    score: document.querySelector('.score-scroll')!.scrollWidth,
  }));
  expect(dimensions.page).toBe(dimensions.viewport);
  expect(dimensions.score).toBeGreaterThan(dimensions.viewport);
  await page.getByRole('button', { name: '显示声部面板', exact: true }).click();
  await expect(page.getByRole('button', { name: /导入音乐/ })).toBeVisible();
});

test('real audio transport checks in an isolated original fixture', async ({ page }) => {
  await page.goto('/tests/browser-audio.html');
  await page.getByRole('button', { name: 'Run browser audio checks', exact: true }).click();
  await expect(page.locator('#status')).toContainText('PASS 15/15', { timeout: 30000 });
  const results = JSON.parse(await page.locator('#results').innerText()) as Array<{ pass: boolean }>;
  expect(results.every((result) => result.pass)).toBe(true);
});

test('rehearsal scope and quick loops do not change score content', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const before = await exportedProject(page);
  await page.getByRole('button', { name: '排练室', exact: true }).click();
  await page.getByRole('button', { name: '练习 长笛 · 主旋律', exact: true }).click();
  await page.getByRole('button', { name: '循环第 5 至 8 小节', exact: true }).click();
  await expect(page.getByLabel('循环开始小节', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('循环结束小节', { exact: true })).toHaveValue('8');
  await expect(page.getByRole('button', { name: '小节循环', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '音符', exact: true })).toHaveCount(0);
  await page.getByTestId('score-note').first().click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Delete');
  const after = await exportedProject(page);
  expect(after.parts).toEqual(before.parts);
  expect(after.chords).toEqual(before.chords);
  await page.getByRole('button', { name: '编配工作台', exact: true }).click();
  await expect(page.getByRole('button', { name: '音符', exact: true })).toBeVisible();
});

test('single-part phone rehearsal fits without horizontal score scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '排练室', exact: true }).click();
  await page.getByRole('button', { name: '显示声部面板', exact: true }).click();
  await page.getByRole('button', { name: '练习 长笛 · 主旋律', exact: true }).click();
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const bounds = await page.evaluate(() => {
    const score = document.querySelector('.score-scroll')!;
    return {
      viewport: innerWidth,
      page: document.documentElement.scrollWidth,
      score: score.scrollWidth,
      width: score.clientWidth,
    };
  });
  expect(bounds.page).toBe(bounds.viewport);
  expect(bounds.score).toBeLessThanOrEqual(bounds.width + 1);
  await page.getByRole('button', { name: '编配工作台', exact: true }).click();
  await page.getByTestId('score-note').first().click();
  await expect(page.getByLabel('音符歌词', { exact: true })).toBeVisible();
});

test('clicking Pause after editing a loop field commits the range without restarting playback', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '排练室', exact: true }).click();
  await page.getByRole('button', { name: '循环第 5 至 8 小节', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
  await page.getByLabel('循环开始小节', { exact: true }).fill('6');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByLabel('循环开始小节', { exact: true })).toHaveValue('6');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await expect(page.locator('.meter-bars .lit')).toHaveCount(0);
});
