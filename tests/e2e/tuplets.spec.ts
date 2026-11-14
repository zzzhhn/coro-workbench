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
type Note = { id: string; midi: number | null; start: number; duration: number };

test('opt-click span -> T makes a bracketed triplet; opt-R re-flows; opt-T restores', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const before = await exportedProject(page);
  const flute: Note[] = before.parts[0].notes;
  // Bar 1 of the demo flute: A4 quarter, C5 eighth, D5 eighth, C5 quarter, A4 quarter.
  const heads = page.locator('[data-testid="score-note"][data-part-id="flute"] path.abcjs-notehead');
  await heads.nth(1).click();
  await page.keyboard.down('Alt');
  await heads.nth(3).click();
  await page.keyboard.up('Alt');
  const bar = page.getByRole('status', { name: '已选音符段' });
  await expect(bar).toContainText('3 个起音');

  await page.keyboard.press('t');
  await expect(page.locator('.toast')).toContainText('3:2 连音');
  const tuplet = await exportedProject(page);
  const third = Math.round((1 / 3) * 960) / 960;
  const moved = tuplet.parts[0].notes.filter((note: Note) => note.start >= 1 - 1e-6 && note.start < 2 - 1e-6);
  expect(moved.map((note: Note) => +note.duration.toFixed(4))).toEqual(
    [third, third, third].map((v) => +v.toFixed(4)),
  );
  // The engraver draws a "3" bracket (abcjs tuplet number) in the first system.
  await expect(page.locator('.abcjs-triplet').first()).toBeVisible();
  // Untouched notes keep their place: the A4 on beat 3 has not moved.
  expect(tuplet.parts[0].notes.find((note: Note) => note.id === flute[4].id).start).toBe(flute[4].start);
  // C5 D5 C5 were eighth, eighth, quarter (1.5 beats of attacks in 2 beats); a 3:2 on an
  // eighth unit spans one beat, so the old beat-2 quarter now leaves a gap: shown, not hidden.
  expect(moved.map((note: Note) => note.midi)).toEqual([72, 74, 72]);

  // Re-flow lays the three attacks end to end (they are already contiguous: no change reported).
  await page.keyboard.press('Alt+KeyR');
  await expect(page.locator('.toast')).toContainText('重排起拍：没有需要改动');

  // ⌥T restores plain values; two actions = two undo steps.
  await page.keyboard.press('Alt+KeyT');
  const restored = await exportedProject(page);
  // Restore gives each attack its plain written value (here eighths) end to end; it is not undo,
  // so the old quarter is not guessed back. Undo is the exact way back.
  expect(
    restored.parts[0].notes
      .filter((note: Note) => note.start >= 1 - 1e-6 && note.start < 2.5)
      .map((note: Note) => [note.start, note.duration]),
  ).toEqual([
    [1, 0.5],
    [1.5, 0.5],
    [2, 0.5],
  ]);
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(2); // triplet + restore (re-flow made no change and recorded nothing)
  expect((await exportedProject(page)).parts).toEqual(before.parts);
  expect(errors).toEqual([]);
});
