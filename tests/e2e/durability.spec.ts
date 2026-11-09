import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createBlankProject } from '../../src/lib/demo';
test.use({ actionTimeout: 10000 });

test('cached score rhythm opens a new score and keeps the edited project in the library', async ({ page }) => {
  const original = createBlankProject();
  original.id = 'b'.repeat(32);
  original.title = '节奏整理前的编辑稿';
  original.parts[0].notes = [{ id: 'edited', midi: 60, start: 0, duration: .125, velocity: .8, lyric: '保留我的修改' }];
  original.source = { kind: 'audio', warnings: [], analysis: { transforms: [],
    rawProjectUrl: `/api/projects/${original.id}/raw`, quality: { decoderProfile: 'yourmt3' } } };
  const rebuilt = structuredClone(original);
  rebuilt.id = 'c'.repeat(32);
  rebuilt.title = '歌曲 · 节奏整理';
  rebuilt.parts[0].notes[0].duration = 1;
  rebuilt.parts[0].notes[0].lyric = undefined;
  await page.route(`**/api/projects/${original.id}/score-rhythm`, route => route.fulfill({ json: rebuilt }));
  await page.goto('/tests/browser-review.html');
  await page.getByRole('button', { name: '工程库', exact: true }).click();
  await page.getByRole('button', { name: '导入音乐', exact: true }).click();
  await page.getByLabel('选择音乐文件').setInputFiles({ name: 'edited.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(original)) });
  await page.getByRole('button', { name: '导入乐谱', exact: true }).click();
  await page.getByRole('button', { name: '重新整理总谱节奏', exact: true }).click();
  await expect(page.getByRole('heading', { name: rebuilt.title, exact: true }).first()).toBeVisible();
  expect((await exportProject(page)).parts[0].notes[0].duration).toBe(1);
  await page.getByRole('button', { name: '工程库', exact: true }).click();
  await page.getByRole('button', { name: /^节奏整理前的编辑稿/ }).click();
  expect((await exportProject(page)).parts[0].notes[0].lyric).toBe('保留我的修改');
});

for (const id of ['Track00009', 'Track00010']) {
  test(`musical rhythm ${id} keeps the dense passage selectable`, async ({ page }) => {
    const file = `evidence/musical-rhythm/${id}-musical.json`;
    test.skip(!existsSync(file), 'Optional local score is not redistributed');
    await page.goto('/tests/browser-review.html');
    await page.getByRole('button', { name: '工程库', exact: true }).click();
    await page.getByRole('button', { name: '导入音乐', exact: true }).click();
    await page.getByLabel('选择音乐文件').setInputFiles(file);
    await page.getByRole('button', { name: '导入乐谱', exact: true }).click();
    await page.getByRole('combobox', { name: '谱面声部', exact: true }).selectOption({ label: id === 'Track00009' ? '有音高打击乐候选' : '原声吉他候选' });
    const jump = page.getByRole('spinbutton', { name: '跳转小节', exact: true });
    await jump.fill(id === 'Track00009' ? '52' : '13');
    await jump.press('Enter');
    await expect(page.locator('.score-error')).toHaveCount(0);
    const target = id === 'Track00009' ? '[data-note-id="mallet-8-q223"]'
      : '[data-part-id="guitar-24"][data-start="48"]';
    await page.locator(`${target} path.abcjs-notehead`).first().click();
    await expect(page.getByLabel('音符时值')).toBeVisible();
  });
}

async function exportProject(page: Page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('radio', { name: /^Coro 工程/ }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文件', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}

async function openReview(page: Page) {
  await page.getByRole('button', { name: '转写修正提案' }).click();
  await page.getByRole('button', { name: /校对原曲主唱音高/ }).click();
  await expect(page.getByLabel('待听检查点', { exact: true })).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存到本机' })).toBeVisible();
}
test('fine polyphony and invisible tuplet gaps render without losing editable notes', async ({ page }) => {
  const project = createBlankProject();
  project.title = '复音渲染回归';
  project.parts[0].notes = [
    { id: 'held', midi: 60, start: 0, duration: 4, velocity: .8, voice: '1' },
    { id: 'tiny', midi: 64, start: 1 / 3, duration: 7 / 960, velocity: .8, voice: '2' },
    { id: 'again', midi: 67, start: .35, duration: .03125, velocity: .8, voice: '2' },
  ];
  project.chords = [{ start: 1 / 3, duration: 1, symbol: 'C', pitches: [60, 64, 67] }];
  await page.goto('/tests/browser-review.html');
  await page.getByRole('button', { name: '工程库', exact: true }).click();
  await page.getByRole('button', { name: '导入音乐', exact: true }).click();
  await page.getByLabel('选择音乐文件').setInputFiles({ name: 'fine-score.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await page.getByRole('button', { name: '导入乐谱', exact: true }).click();
  await expect(page.getByRole('heading', { name: project.title, exact: true }).first()).toBeVisible();
  await expect(page.locator('.score-error')).toHaveCount(0);
  await expect(page.locator('[data-note-id="tiny"]').first()).toBeVisible();
  await expect(page.locator('[data-note-id="again"]').first()).toBeVisible();
});

for (const id of ['Track00009', 'Track00010']) {
  test(`frozen full song ${id} renders and remains editable`, async ({ page }) => {
    const file = `data/p0-multiscore/full-songs/${id}/project.json`;
    test.skip(!existsSync(file), 'Optional local benchmark output is not redistributed');
    await page.goto('/tests/browser-review.html');
    await page.getByRole('button', { name: '工程库', exact: true }).click();
    await page.getByRole('button', { name: '导入音乐', exact: true }).click();
    await page.getByLabel('选择音乐文件').setInputFiles(file);
    await page.getByRole('button', { name: '导入乐谱', exact: true }).click();
    await expect(page.getByRole('heading', { name: id, exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('score-note').first()).toBeVisible();
    await expect(page.locator('.score-error')).toHaveCount(0);
    const scale = await page.locator('.notation svg').first().evaluate((svg) => svg.getBoundingClientRect().width / (svg as SVGSVGElement).viewBox.baseVal.width);
    expect(scale).toBeGreaterThan(.8);
    await page.getByTestId('score-note').first().locator('path.abcjs-notehead').first().click();
    await expect(page.locator('.selected-pitch')).toBeVisible();
  });
}
test('whole-song multi import defaults to 600 seconds and clamps other modes', async ({ page }) => {
  let submitted = '';
  await page.route('**/api/analyze', async (route) => {
    submitted = route.request().postData() ?? '';
    await route.fulfill({ status: 422, json: { detail: '已记录测试请求' } });
  });
  await page.goto('/tests/browser-review.html?phoneme=ready&game=ready');
  await page.getByRole('button', { name: '工程库', exact: true }).click();
  await page.getByRole('button', { name: '导入音乐', exact: true }).click();
  await page.getByLabel('选择音乐文件').setInputFiles({ name: 'full-song.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF-test-audio') });
  await expect(page.getByRole('radio', { name: /多声部总谱/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('分析长度')).toHaveValue('600');
  await expect(page.getByRole('button', { name: '开始转谱', exact: true })).toBeEnabled();
  await page.getByLabel('分析长度').selectOption('180');
  await page.getByRole('radio', { name: /多声部总谱/ }).click();
  await expect(page.getByLabel('分析长度')).toHaveValue('180');
  await page.getByLabel('分析长度').selectOption('600');
  await page.screenshot({ path: 'evidence/multiscore-import-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('分析长度').scrollIntoViewIfNeeded();
  await expect(page.getByLabel('分析长度')).toBeVisible();
  await page.screenshot({ path: 'evidence/multiscore-import-mobile.png' });
  await page.getByRole('radio', { name: /直接转谱/ }).click();
  await expect(page.getByLabel('分析长度')).toHaveValue('300');
  await expect(page.getByRole('option', { name: /完整歌曲/ })).toHaveCount(0);
  await page.getByRole('radio', { name: /多声部总谱/ }).click();
  await page.getByRole('button', { name: '开始转谱', exact: true }).click();
  await expect(page.getByText('已记录测试请求', { exact: true })).toBeVisible();
  expect(submitted).toMatch(/name="max_seconds"\r\n\r\n600/);
  expect(submitted).toMatch(/name="mode"\r\n\r\nmulti/);
  expect(submitted).toMatch(/name="decoder"\r\n\r\ngame/);
});
test('a rescued vocal remains reviewable without offering an invalid empty baseline', async ({ page }) => {
  await page.goto('/tests/browser-review.html?rescued=1');
  await page.getByRole('button', { name: '转写修正提案' }).click();
  await expect(page.getByRole('button', { name: /打开原始模型副本/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /模型分歧证据/ })).toBeVisible();
  await page.getByRole('button', { name: /校对原曲主唱音高/ }).click();
  await expect(page.getByLabel('待听检查点', { exact: true })).toBeVisible();
  await page.getByLabel('校对音符', { exact: true }).selectOption('note-a');
  await expect(page.getByLabel('校对音高 MIDI')).toHaveValue('60');
});
for (const ready of [false, true]) {
  test(`optional phoneme transcription respects runtime readiness: ${ready}`, async ({ page }) => {
    await page.goto(`/tests/browser-review.html?phoneme=${ready ? 'ready' : 'missing'}`);
    await page.getByRole('button', { name: '工程库', exact: true }).click();
    await page.getByRole('button', { name: '导入音乐', exact: true }).click();
    await page.getByLabel('选择音乐文件').setInputFiles({
      name: 'synthetic.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF-test-audio'),
    });
    await page.getByRole('radio', { name: /分轨转谱/ }).click();
    await expect(page.getByLabel('主唱分段策略')).toHaveValue('game');
    await expect(page.getByRole('button', { name: '开始转谱', exact: true })).toBeDisabled();
    // Playwright's enabled-state matcher follows an option's enclosing label
    // to the enabled select. Check the native option property itself.
    await expect(page.getByRole('option', { name: /词音节奏/ })).toHaveJSProperty('disabled', true);
    await expect(page.getByRole('option', { name: /发音边界/ })).toHaveJSProperty('disabled', !ready);
    // Missing GAME must not silently select a legacy engine. A deliberate
    // comparison choice still works when that engine is available.
    await page.getByLabel('主唱分段策略').selectOption(ready ? 'phoneme' : 'standard');
    await expect(page.getByRole('button', { name: '开始转谱', exact: true })).toBeEnabled();
  });
}
test('review survives closing and reload; undo, status and apply preserve source until accepted', async ({
  page,
}) => {
  await page.goto('/tests/browser-review.html');
  await openReview(page);
  await page.getByLabel('校对音符', { exact: true }).selectOption('note-a');
  await saved(page);
  await page.getByLabel('校对音高 MIDI').fill('62');
  await page.getByRole('button', { name: '更新草稿', exact: true }).click();
  await saved(page);
  await page.getByLabel('待听检查点', { exact: true }).selectOption('0');
  await saved(page);
  await page.getByLabel('检查点状态').selectOption('confirmed');
  await saved(page);
  await page.getByRole('button', { name: '保留草稿并返回' }).click();
  expect((await exportProject(page)).parts[0].notes[0].midi).toBe(60);
  await page.reload();
  await openReview(page);
  await expect(page.getByLabel('检查点状态')).toHaveValue('confirmed');
  await page.getByLabel('校对音符', { exact: true }).selectOption('note-a');
  await saved(page);
  await expect(page.getByLabel('校对音高 MIDI')).toHaveValue('62');
  await page.getByRole('button', { name: '撤销校对', exact: true }).click();
  await saved(page);
  await expect(page.getByLabel('检查点状态')).toHaveValue('pending');
  await page.getByRole('button', { name: '撤销校对', exact: true }).click();
  await saved(page);
  await expect(page.getByLabel('校对音高 MIDI')).toHaveValue('60');
  await page.getByRole('button', { name: '重做校对', exact: true }).click();
  await saved(page);
  await expect(page.getByLabel('校对音高 MIDI')).toHaveValue('62');
  await page.getByRole('button', { name: '应用到原曲', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await exportProject(page)).parts[0].notes[0].midi).toBe(62);
});

test('named versions open as copies and deleting requires an explicit choice', async ({ page }) => {
  await page.goto('/tests/browser-review.html');
  await page.getByRole('button', { name: '工程库', exact: true }).click();
  await page.getByLabel('版本名称').fill('排练前');
  await page.getByRole('button', { name: '保存命名版本' }).click();
  await expect(page.getByRole('button', { name: /排练前.*打开为副本/ })).toBeVisible();
  await page.getByRole('button', { name: '删除排练前', exact: true }).click();
  await page.getByRole('button', { name: '保留', exact: true }).click();
  await page.getByRole('button', { name: /排练前.*打开为副本/ }).click();
  await expect(
    page.getByRole('heading', { name: '校对恢复测试 · 排练前', exact: true, level: 1 }),
  ).toBeVisible();
  await page.getByRole('button', { name: '工程库', exact: true }).click();
  await page.getByRole('button', { name: '命名版本', exact: true }).click();
  await expect(page.getByRole('button', { name: /排练前.*打开为副本/ })).toBeVisible();
});

test('archive failure prevents a workspace switch and preserves manual edits', async ({ page }) => {
  await page.goto('/tests/browser-storage.html');
  await page.getByRole('button', { name: '新建空白乐谱', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Storage Guard Fixture', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('未能保存当前工程，已取消切换。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Allow archival', exact: true }).click();
  await page.getByRole('button', { name: '新建空白乐谱', exact: true }).click();
  await page.getByRole('button', { name: '工程库', exact: true }).click();
  await page.getByRole('button', { name: /^Storage Guard Fixture/ }).click();
  expect((await exportProject(page)).parts[0].notes[0].lyric).toBe('keep this edit');
});

test('a newer source blocks draft recovery and the old draft remains exportable', async ({ page }) => {
  await page.goto('/tests/browser-review.html');
  await openReview(page);
  await page.getByLabel('校对音符', { exact: true }).selectOption('note-a');
  await saved(page);
  await page.getByLabel('校对音高 MIDI').fill('62');
  await page.getByRole('button', { name: '更新草稿', exact: true }).click();
  await saved(page);
  await page.getByRole('button', { name: '保留草稿并返回' }).click();
  const newer = await exportProject(page);
  newer.parts[0].notes[0].midi = 65;
  await page.getByRole('button', { name: /^导入音乐/ }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: 'newer.coro.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(newer)),
    });
  await page.getByRole('button', { name: /导入乐谱|导入工程|开始导入|打开乐谱/ }).click();
  await page.getByRole('button', { name: '校对原曲主唱音高', exact: false }).click();
  await expect(page.getByText('原谱在上次校对后已改变。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '应用到原曲', exact: true })).toBeDisabled();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出旧草稿', exact: true }).click();
  expect(JSON.parse(await readFile((await (await pending).path())!, 'utf8')).parts[0].notes[0].midi).toBe(62);
});
