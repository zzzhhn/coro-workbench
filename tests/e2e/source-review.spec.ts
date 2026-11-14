import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Public fixture (CC BY 4.0, see tests/fixtures/omr-review/README.md), served as a
// completed OMR job so the test needs neither the OMR engines nor private scores.
const ID = 'b'.repeat(32);
const dir = 'tests/fixtures/omr-review/airds-air';

async function importFixture(page: Page) {
  await page.route(`**/api/omr/jobs/${ID}`, (route) =>
    route.fulfill({
      json: {
        id: ID,
        status: 'complete',
        progress: 100,
        stage: 'complete',
        message: '',
        musicxml: readFileSync(`${dir}/homr.musicxml`, 'utf8'),
        source: { filename: 'airds-air.png', engine: 'homr' },
        pageUrls: [`/api/omr/jobs/${ID}/pages/1`],
        review: JSON.parse(readFileSync(`${dir}/review.json`, 'utf8')),
      },
    }),
  );
  await page.route(`**/api/omr/jobs/${ID}/pages/1`, (route) =>
    route.fulfill({ body: readFileSync(`${dir}/page-001.png`), contentType: 'image/png' }),
  );
  await page.goto('/');
  await page.evaluate((id) => localStorage.setItem('coro.pending-analysis.v1', `omr:${id}`), ID);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'airds-air', exact: true }).first()).toBeVisible({
    timeout: 15000,
  });
  await page.keyboard.press('Escape');
}

test('source image review: score <-> page, filtered queue, approximate wording', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await importFixture(page);

  await page.keyboard.press('o');
  const panel = page.getByRole('complementary', { name: '原谱对照' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('img', { name: /原谱第 1 页/ })).toBeVisible();
  await expect(panel).toContainText('近似位置');
  await expect(panel).not.toContainText(/置信/);

  // Score -> source: selecting a note zooms to its bar and shows its anchor.
  await page.locator('[data-testid="score-note"] path.abcjs-notehead').nth(3).click();
  const where = await page.locator('.selected-pitch p').innerText();
  const bar = Number(/第 (\d+) 小节/.exec(where)![1]);
  await expect(panel.locator('header span')).toContainText(`第 ${bar} 小节`);
  await expect(panel.getByTestId('source-anchor')).toHaveCount(1);
  await expect(panel.locator('.source-box.current')).toHaveAttribute('data-measure', String(bar));

  // Source -> score: click another bar on the page and the score follows.
  await panel.getByRole('button', { name: /局部/ }).click();
  const target = panel.locator('.source-box[data-measure="6"]');
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.selected-pitch p')).toContainText('第 6 小节');

  // Reasons: four notation-caused underfull bars; [ ] walks the filtered queue.
  const filters = panel.getByRole('group', { name: '按原因筛选' });
  await filters.getByRole('button', { name: /小节不满拍 4/ }).click();
  await expect(panel.locator('.source-issues li')).toHaveCount(4);
  await expect(panel.locator('.source-issues li').first()).toContainText('可能是弱起或反复处的分割小节');
  const visited: string[] = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press(']');
    visited.push(await panel.locator('header span').innerText());
  }
  // From bar 6 (the last source click) forward, wrapping to the start.
  expect(visited.map((text) => /第 (\d+) 小节/.exec(text)![1])).toEqual(['9', '10', '18', '1', '9']);
  await expect(page.getByRole('button', { name: '下一处待校对' })).toContainText('4');
  expect(errors).toEqual([]);
});

test('projects without source pages show no source-review entry', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('score-note').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '原谱对照', exact: true })).toHaveCount(0);
  await page.keyboard.press('o');
  await expect(page.getByRole('complementary', { name: '原谱对照' })).toHaveCount(0);
});
