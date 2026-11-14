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

/** Screen geometry of the n-th system's staff for a voice index, and its barlines. */
async function staffGeometry(page: Page, system: number, voice: number) {
  return page.evaluate(
    ([system, voice]) => {
      const svg = document.querySelectorAll('.notation svg')[system];
      const staff = svg.querySelector(`.abcjs-staff.abcjs-v${voice}`)!;
      const lines = [...staff.querySelectorAll('path')].map((line) => line.getBoundingClientRect());
      const bars = [...svg.querySelectorAll(`.abcjs-bar.abcjs-v${voice}`)].map(
        (bar) => bar.getBoundingClientRect().left,
      );
      const start =
        Math.max(
          ...[...svg.querySelectorAll(`.abcjs-staff-extra.abcjs-v${voice}`)].map(
            (item) => item.getBoundingClientRect().right,
          ),
        ) + 4;
      return {
        start,
        top: lines[0].top + lines[0].height / 2,
        bottom: lines.at(-1)!.top + lines.at(-1)!.height / 2,
        left: Math.min(...lines.map((line) => line.left)),
        bars,
      };
    },
    [system, voice] as const,
  );
}

test('click-to-place: staff position -> pitch in key, x -> beat, chord merge, rest tool, undo', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  const before = await exportedProject(page);

  await page.keyboard.press('p');
  await expect(page.getByRole('status', { name: '鼠标放音' })).toBeVisible();
  await page.keyboard.press('Digit4'); // eighth
  // Cello (voice 2 of the demo's ABC: flute V1, harmony lane, piano, cello...) is a bass-clef staff;
  // use the flute's treble staff (voice 0) in system 0, bar 4 (after the 3rd barline).
  const g = await staffGeometry(page, 0, 0);
  const half = (g.bottom - g.top) / 8;
  const bar4x = g.bars[2] + 6; // just after the barline: beat 12
  // Top line in F major treble = F5, hover shows a ghost with that pitch.
  await page.mouse.move(bar4x + 4, g.top);
  await expect(page.getByTestId('placement-ghost')).toContainText('F5');
  await page.mouse.click(bar4x + 4, g.top);
  // Middle line = B -> Bb in F major.
  await page.mouse.click(bar4x + 4, g.top + 4 * half);
  const placed = await exportedProject(page);
  const atBar4 = placed.parts[0].notes.filter((note: Note) => note.start === 12);
  const original = before.parts[0].notes.filter((note: Note) => note.start === 12);
  // Bar 4 beat 1 already has an attack: both clicks become chord tones with that attack's length.
  expect(atBar4.map((note: Note) => note.midi).sort((a: number, b: number) => a - b)).toEqual(
    [...original.map((note: Note) => note.midi), 70, 77].sort((a, b) => a - b),
  );
  expect(new Set(atBar4.map((note: Note) => note.duration))).toEqual(new Set([original[0].duration]));

  // Rest tool on an empty spot of the piano staff later in bar 2: ⇧P then click.
  await page.keyboard.press('Shift+KeyP');
  await expect(page.getByRole('status', { name: '鼠标放音' })).toContainText('休止符');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status', { name: '鼠标放音' })).toHaveCount(0);

  // Each click is one undo step; undo back to the demo.
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  let steps = 0;
  while (await undo.isEnabled()) {
    await undo.click();
    steps++;
  }
  expect(steps).toBe(2);
  expect((await exportedProject(page)).parts).toEqual(before.parts);
  expect(errors).toEqual([]);
});

test('click-to-place on an empty score writes the clicked pitches and beats', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  await page.getByRole('button', { name: '新建空白乐谱' }).click();
  await expect(page.getByTestId('score')).toBeVisible();
  await page.keyboard.press('p');
  await page.keyboard.press('Digit3'); // quarter
  // Each click re-engraves the bar, so read the live geometry before every click:
  // the next quarter goes a little right of the last placed note (the ghost shows the beat).
  for (const [beat, step] of [
    [0, 8],
    [1, 7],
    [2, 6],
    [3, 10],
  ] as const) {
    const g = await staffGeometry(page, 0, 0);
    const half = (g.bottom - g.top) / 8;
    // Interpolate between the last engraved attack (centre, at its beat) and the barline (beat 4).
    const last = await page.evaluate(() => {
      const nodes = [
        ...document
          .querySelectorAll('.notation svg')[0]
          .querySelectorAll<SVGElement>('[data-testid="score-note"]'),
      ];
      const node = nodes.at(-1);
      const head = node?.querySelector('.abcjs-notehead')?.getBoundingClientRect();
      return node && head ? { x: head.left + head.width / 2, beat: Number(node.dataset.start) } : undefined;
    });
    const from = last ?? { x: g.start, beat: 0 };
    const x = from.x + ((g.bars[0] - from.x) * (beat + 0.3 - from.beat)) / (4 - from.beat);
    await page.mouse.move(x, g.top + step * half);
    await expect(page.getByTestId('placement-ghost')).toContainText(`第 1 小节第 ${beat + 1} 拍`);
    await page.mouse.click(x, g.top + step * half);
  }
  const out = await exportedProject(page);
  expect(out.parts[0].notes.map((note: Note) => [note.start, note.midi, note.duration])).toEqual([
    [0, 64, 1],
    [1, 65, 1],
    [2, 67, 1],
    [3, 60, 1],
  ]);
});
