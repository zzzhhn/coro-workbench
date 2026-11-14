import { test, expect } from '@playwright/test';

// The toolbar duration buttons are Bravura (SMuFL) glyphs. If the font file is not
// served (e.g. a linked node_modules outside Vite's allow list returns 403), the
// browser draws empty tofu boxes while every text/role assertion still passes.
test('duration toolbar glyphs render with the loaded Bravura font', async ({ page }) => {
  const failedFonts: string[] = [];
  page.on('response', (response) => {
    if (/\.(woff2?|otf|ttf)(\?|$)/.test(response.url()) && response.status() >= 400)
      failedFonts.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('/');
  const buttons = page.locator('.duration-button');
  await expect(buttons).toHaveCount(5);
  await page.evaluate(() => document.fonts.ready);

  const fonts = await page.evaluate(async () => {
    const error = await document.fonts.load('24px Bravura', '\ue1d5').then(
      () => '',
      (cause: Error) => cause.message,
    );
    return {
      error,
      bravura: document.fonts.check('24px Bravura', '\ue1d5'),
      loaded: [...document.fonts]
        .filter((face) => face.family.replace(/["']/g, '') === 'Bravura')
        .map((face) => face.status),
    };
  });
  expect(failedFonts).toEqual([]);
  expect(fonts.error).toBe('');
  expect(fonts.loaded).toContain('loaded');
  expect(fonts.bravura).toBe(true);

  // Visual assertion (platform-independent, so it also runs on Linux CI): draw each
  // button's glyph with "Bravura, monospace" and with plain monospace. If Bravura
  // is missing both fall back to the same tofu and the pixels are identical.
  const ink = await page.evaluate(() => {
    const measure = (family: string, glyph: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.font = `40px ${family}`;
      context.fillStyle = '#000';
      context.fillText(glyph, 12, 48);
      const { data } = context.getImageData(0, 0, 64, 64);
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) painted++;
      return { painted, data: canvas.toDataURL() };
    };
    return [...document.querySelectorAll<HTMLButtonElement>('.duration-button')].map((button) => {
      const glyph = button.textContent ?? '';
      return {
        glyph: glyph.codePointAt(0)?.toString(16),
        music: measure('Bravura, monospace', glyph).data,
        fallback: measure('monospace', glyph).data,
        painted: measure('Bravura, monospace', glyph).painted,
      };
    });
  });
  for (const item of ink) {
    expect(item.painted, item.glyph).toBeGreaterThan(20);
    expect(item.music, `${item.glyph} drawn with the fallback font`).not.toBe(item.fallback);
  }
  await page
    .locator('.editing-toolbar .entry-tools')
    .screenshot({ path: test.info().outputPath('duration-tools.png') });
});
