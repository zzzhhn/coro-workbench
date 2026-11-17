import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function exportedProject(page: Page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('radio', { name: /^Coro 工程/ }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  const download = await pending;
  if (await page.getByRole('button', { name: '导出文件', exact: true }).isVisible())
    await page.keyboard.press('Escape');
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}
const systemStarts = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.notation svg')].map((svg) => [
      svg.getAttribute('aria-label')?.match(/第 (\d+) 小节起/)?.[1],
      (svg as SVGElement).dataset.break,
      // Pitched clefs only: the percussion clef always stays, it identifies the drum staff.
      [...svg.querySelectorAll('.abcjs-clef')].filter(
        (clef) => !clef.querySelector('[data-name="clefs.perc"]'),
      ).length,
      svg.querySelectorAll('.abcjs-key-signature').length,
    ]),
  );

test('line and page breaks from the keyboard, repeat rules in settings, one undo each', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  await page.getByRole('combobox', { name: '每段显示小节' }).selectOption('all');
  const before = await exportedProject(page);
  expect((await systemStarts(page)).map((row) => row[0])).toEqual(['1', '5', '9', '13']);

  // ⌥↵ on a note in bar 3: a new line starts at bar 3.
  const flute = before.parts[0].notes;
  const bar3 = flute.findIndex((note: { start: number }) => note.start >= 8);
  await page
    .locator('[data-testid="score-note"][data-part-id="flute"] path.abcjs-notehead')
    .nth(bar3)
    .click();
  await page.keyboard.press('Alt+Enter');
  await expect(page.locator('.toast')).toContainText('第 3 小节起换行');
  await expect
    .poll(async () => (await systemStarts(page)).map((row) => row[0]))
    .toEqual(['1', '3', '7', '11', '15']);
  expect((await systemStarts(page))[1][1]).toBe('system');

  // ⌥⇧↵ on bar 9: page break, also a line start.
  const bar9 = flute.findIndex((note: { start: number }) => note.start >= 32);
  await page
    .locator('[data-testid="score-note"][data-part-id="flute"] path.abcjs-notehead')
    .nth(bar9)
    .click();
  await page.keyboard.press('Alt+Shift+Enter');
  await expect
    .poll(async () => (await systemStarts(page)).map((row) => row[0]))
    .toEqual(['1', '3', '7', '9', '13']);
  expect((await systemStarts(page))[3][1]).toBe('page');

  // Settings: clef only on the first line of each page, key signature only on the first line.
  await page.locator('button.project-title').click();
  await page.getByLabel('谱号重复').selectOption('page');
  await page.getByLabel('调号重复').selectOption('first');
  await page.keyboard.press('Escape');
  const rows = await systemStarts(page);
  const parts = before.parts.length;
  // clefs: line 1 and the page start (line 4) only; key signatures: line 1 only (percussion has none).
  expect(rows.map((row) => (row[2] as number) > 0)).toEqual([true, false, false, true, false]);
  expect(rows.map((row) => (row[3] as number) > 0)).toEqual([true, false, false, false, false]);
  expect(rows[0][2]).toBe(parts - 1); // every pitched staff (drums excluded)

  const after = await exportedProject(page);
  expect(after.layout).toEqual({
    systemBreaks: [3],
    pageBreaks: [9],
    repeat: { clef: 'page', key: 'first', labels: 'every' },
  });
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(4);
  expect((await exportedProject(page)).layout).toBeUndefined();
  expect(errors).toEqual([]);
});
