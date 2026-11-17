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
type Part = { id: string; notes: Note[] };
const shifted = (part: Part, from: number, by: number) =>
  part.notes.filter((note) => note.start >= from).map((note) => [note.start + by, note.midi]);

test('insert after, insert before and delete bars across every part, each one undo step', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const before = await exportedProject(page);

  // Select a flute note in bar 2, ⌘B inserts an empty bar 3.
  const second = before.parts[0].notes.findIndex((note: Note) => note.start >= 4);
  await page
    .locator('[data-testid="score-note"][data-part-id="flute"] path.abcjs-notehead')
    .nth(second)
    .click();
  await page.keyboard.press('Meta+b');
  await expect(page.locator('.toast')).toContainText('已在第 2 小节后插入');
  const inserted = await exportedProject(page);
  expect(inserted.measures).toBe(before.measures + 1);
  for (const [index, part] of before.parts.entries())
    expect(
      inserted.parts[index].notes
        .filter((note: Note) => note.start >= 12)
        .map((note: Note) => [note.start, note.midi]),
    ).toEqual(shifted(part, 8, 4));
  expect(
    inserted.parts.every((part: Part) => !part.notes.some((note) => note.start >= 8 && note.start < 12)),
  ).toBe(true);
  expect(inserted.chords.filter((chord: { start: number }) => chord.start >= 8 && chord.start < 12)).toEqual(
    [],
  );

  // Toolbar: delete the (now empty) bar 3 again.
  await page.getByLabel('跳转小节').fill('3');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '删除小节', exact: true }).first().click();
  await expect(page.locator('.toast')).toContainText('已删除第 3 小节');
  const deleted = await exportedProject(page);
  expect(deleted.measures).toBe(before.measures);
  expect(deleted.parts.map((part: Part) => part.notes.map((note) => [note.start, note.midi]))).toEqual(
    before.parts.map((part: Part) => part.notes.map((note) => [note.start, note.midi])),
  );

  // Range: shift-click bars 1-2 of the flute, ⌘⌫ deletes both bars in every part.
  const heads = page.locator('[data-testid="score-note"][data-part-id="flute"] path.abcjs-notehead');
  await heads.first().click();
  await page.keyboard.down('Shift');
  await heads.nth(second).click();
  await page.keyboard.up('Shift');
  await page.keyboard.press('Meta+Backspace');
  await expect(page.locator('.toast')).toContainText('已删除第 1–2 小节');
  const trimmed = await exportedProject(page);
  expect(trimmed.measures).toBe(before.measures - 2);
  expect(trimmed.parts[0].notes.map((note: Note) => [note.start, note.midi])).toEqual(
    shifted(before.parts[0], 8, -8),
  );

  const undo = page.getByRole('button', { name: '撤销', exact: true });
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(3);
  expect((await exportedProject(page)).parts).toEqual(before.parts);
  expect(errors).toEqual([]);
});
