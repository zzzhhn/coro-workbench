import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

async function exportedProject(page: Page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('radio', { name: /^Coro 工程/ }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  const download = await pending;
  await page.keyboard.press('Escape');
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}

const heading = (page: Page) => page.locator('.selected-pitch h3');

test('keyboard proof-reading: pitch, duration, rest, lyric flow and undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const before = await exportedProject(page);

  // Demo melody starts on A4 in F major.
  await page.getByTestId('score-note').first().locator('path').first().click();
  await expect(heading(page)).toHaveText('A4');

  await page.keyboard.press('ArrowUp'); // diatonic: A -> Bb in F major
  await expect(heading(page)).toHaveText('A#4');
  await page.keyboard.press('ArrowDown');
  await expect(heading(page)).toHaveText('A4');
  await page.keyboard.press('b'); // letter inside key signature -> Bb
  await expect(heading(page)).toHaveText('A#4');
  await page.keyboard.press('0'); // natural
  await expect(heading(page)).toHaveText('B4');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(heading(page)).toHaveText('B3');

  await page.keyboard.press('Digit4'); // eighth
  await expect(page.getByLabel('音符时值', { exact: true })).toHaveValue('0.5');
  await page.keyboard.press('.'); // dotted eighth
  await expect(page.getByLabel('音符时值', { exact: true })).toHaveValue('0.75');
  await page.keyboard.press('r');
  await expect(heading(page)).toHaveText('休止符');
  await page.keyboard.press('r');
  await expect(heading(page)).not.toHaveText('休止符');

  // Lyric flow: L focuses the field, Space commits and moves to the next note.
  await page.keyboard.press('ArrowRight');
  const secondStart = await page.getByLabel('音符起拍', { exact: true }).inputValue();
  await page.keyboard.press('l');
  const lyric = page.getByLabel('音符歌词', { exact: true });
  await expect(lyric).toBeFocused();
  await lyric.fill('la');
  await lyric.press(' ');
  await expect(page.getByLabel('音符起拍', { exact: true })).not.toHaveValue(secondStart);
  await expect(lyric).toBeFocused();
  await lyric.fill('di');
  await lyric.press('-');
  await lyric.press('Escape');

  const edited = await exportedProject(page);
  const lyrics = edited.parts[0].notes.map((n: { lyric?: string }) => n.lyric).filter(Boolean);
  expect(lyrics.slice(0, 2)).toEqual(['la', 'di-']);
  expect(edited.parts.slice(1)).toEqual(before.parts.slice(1)); // other parts untouched

  // Every keyboard edit is one undo step; undo all the way back to the original.
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(11); // ↑ ↓ b 0 ⇧↓ 4 . r r + two lyric commits: one undo step each
  await expect(undo).toBeDisabled();
  const restored = await exportedProject(page);
  expect(restored.parts).toEqual(before.parts);
  expect(errors).toEqual([]);
});

test('review queue jumps between overlaps and low-confidence notes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  await page.getByTestId('score-note').first().locator('path').first().click();
  // Lengthen the first note over its neighbours: neighbours stay, overlap is queued.
  await page.keyboard.press('Digit1');
  await expect(page.getByRole('alert')).toContainText('后续音符未移动');
  const count = Number(await page.locator('.issue-count').innerText());
  expect(count).toBeGreaterThan(0);
  await page.keyboard.press(']');
  await expect(page.getByRole('status')).toContainText('前一音符尚未结束');
  await expect(page.locator('.selected-note').first()).toBeVisible();
});
