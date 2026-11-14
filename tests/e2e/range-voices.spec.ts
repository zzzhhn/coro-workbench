import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function exportedProject(page: Page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('radio', { name: /^Coro 工程/ }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  const download = await pending;
  // Export may close its own dialog; a stray Escape would also clear the range.
  if (await page.getByRole('button', { name: '导出文件', exact: true }).isVisible())
    await page.keyboard.press('Escape');
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}
type Note = { id: string; midi: number | null; start: number; duration: number; voice?: string };
const barSig = (notes: Note[], from: number, length = 4) =>
  notes
    .filter((note) => note.start >= from - 1e-6 && note.start < from + length - 1e-6)
    .map((note) => `${note.midi}@${+(note.start - from).toFixed(3)}/${note.duration}`)
    .sort()
    .join(' ');

test('shift-click range, copy, overwrite and insert paste, voices, one undo per action', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const before = await exportedProject(page);
  const flute = before.parts[0];

  // Anchor on the first flute note (bar 1), shift-click a flute note in bar 2.
  const fluteHeads = page.locator(
    `[data-testid="score-note"][data-part-id="${flute.id}"] path.abcjs-notehead`,
  );
  await fluteHeads.first().click();
  const bar2 = flute.notes.findIndex((note: Note) => note.start >= 4);
  await page.keyboard.down('Shift');
  await fluteHeads.nth(bar2).click();
  await page.keyboard.up('Shift');
  const bar = page.getByRole('status', { name: '已选范围' });
  await expect(bar).toContainText('第 1–2 小节 · 1 个声部');
  await expect(page.locator('.range-note').first()).toBeVisible();

  await page.keyboard.press('Meta+c');
  // Paste target: a flute note in bar 3.
  await page.keyboard.press('Escape');
  const bar3 = flute.notes.findIndex((note: Note) => note.start >= 8);
  await fluteHeads.nth(bar3).click();
  await page.keyboard.press('Meta+v');
  await expect(bar).toContainText('第 3–4 小节');
  const pasted = await exportedProject(page);
  expect(barSig(pasted.parts[0].notes, 8, 8)).toBe(barSig(flute.notes, 0, 8));
  expect(pasted.parts.slice(1)).toEqual(before.parts.slice(1));
  expect(pasted.measures).toBe(before.measures);

  // Insert paste at bar 3 pushes the rest of every part two bars later.
  await page.keyboard.press('Meta+Shift+v');
  const inserted = await exportedProject(page);
  expect(inserted.measures).toBe(before.measures + 2);
  const cello = before.parts.findIndex((part: { role: string }) => part.role === 'bass');
  expect(barSig(inserted.parts[cello].notes, 16, 4)).toBe(barSig(before.parts[cello].notes, 8, 4));

  // ⌥2 moves the selected range into voice 2; the toolbar reflects it.
  await page.keyboard.press('Alt+Digit2');
  await expect(page.getByRole('button', { name: '声部 2' })).toHaveAttribute('aria-pressed', 'true');
  const voiced = await exportedProject(page);
  const moved = voiced.parts[0].notes.filter((note: Note) => note.start >= 8 && note.start < 16);
  expect(moved.length).toBeGreaterThan(0);
  expect(moved.map((note: Note) => [note.start, note.voice])).toEqual(
    moved.map((note: Note) => [note.start, '2']),
  );
  await expect(page.getByTestId('score-note').first()).toBeVisible();

  // Cut empties the range; delete is undoable; three edits + cut = four undo steps back to the start.
  await page.keyboard.press('Meta+x');
  const cut = await exportedProject(page);
  expect(cut.parts[0].notes.some((note: Note) => note.start >= 8 && note.start < 16)).toBe(false);
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(4);
  expect((await exportedProject(page)).parts).toEqual(before.parts);
  expect(errors).toEqual([]);
});

test('rubber band selects whole bars of the staves it crosses', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const surface = (await page.locator('.notation-surface').boundingBox())!;
  // Visible glyph boxes per part (some selectable glyphs, e.g. spacer rests, have no size).
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll<SVGElement>('[data-testid="score-note"]')]
      .map((node) => ({ part: node.dataset.partId, box: node.getBoundingClientRect().toJSON() as DOMRect }))
      .filter((item) => item.box.width > 0 && item.box.height > 0),
  );
  const flute = boxes.find((item) => item.part === 'flute')!.box;
  const piano = boxes
    .filter((item) => item.part === 'piano')
    .sort((a, b) => b.box.bottom - a.box.bottom)[0].box;
  // From above the flute staff at the start of bar 1, down through the piano staff, into bar 2.
  await page.mouse.move(flute.x - 6, flute.y - 30);
  await page.mouse.down();
  await page.mouse.move(surface.x + surface.width * 0.42, piano.y + piano.height + 6, { steps: 10 });
  await expect(page.getByTestId('rubber-band')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole('status', { name: '已选范围' })).toContainText(/第 1(–2)? 小节 · 2 个声部/);
  await expect(page.getByTestId('rubber-band')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status', { name: '已选范围' })).toHaveCount(0);
});
