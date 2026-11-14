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
type Chord = { start: number; duration: number; symbol: string };

test('click a chord on the paper to edit in place; Tab walks chords; K adds one over a note', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('score-chord').first()).toBeVisible();
  const before = await exportedProject(page);

  // The first engraved chord (Fmaj7, bar 1) is clickable and opens an inline field on the paper.
  await page.getByTestId('score-chord').first().click();
  const field = page.getByLabel('和弦符号（就地编辑）');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Fmaj7');
  await field.fill('F6');
  await field.press('Tab'); // commit, move to the next change (bar 2)
  await expect(field).toHaveValue('C/E');
  await field.fill('Hm7'); // not a chord: flagged, not committed on Tab
  await expect(page.locator('.chord-inline.invalid')).toBeVisible();
  await field.press('Tab');
  await expect(page.locator('.toast')).toContainText('不是可识别的和弦');
  await field.fill('C/E');
  await field.press('Escape');
  await expect(field).toHaveCount(0);

  // K over a selected note in bar 1 beat 3 adds a new chord change there.
  const flute = before.parts[0].notes;
  const third = flute.findIndex((note: { start: number }) => note.start === 2);
  await page
    .locator('[data-testid="score-note"][data-part-id="flute"] path.abcjs-notehead')
    .nth(third)
    .click();
  await page.keyboard.press('k');
  await expect(field).toBeFocused();
  await field.fill('Bb');
  await field.press('Enter');
  await expect(page.locator('[data-testid="score-chord"]', { hasText: 'B♭' }).first()).toBeVisible();

  const after = await exportedProject(page);
  const bar1 = after.chords
    .filter((chord: Chord) => chord.start < 4)
    .map((chord: Chord) => [chord.symbol, chord.start, chord.duration]);
  expect(bar1).toEqual([
    ['F6', 0, 2],
    ['Bb', 2, 2],
  ]);
  expect(after.chords.find((chord: Chord) => chord.start === 4).symbol).toBe('C/E');

  const undo = page.getByRole('button', { name: '撤销', exact: true });
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(2);
  expect((await exportedProject(page)).chords).toEqual(before.chords);
  expect(errors).toEqual([]);
});
