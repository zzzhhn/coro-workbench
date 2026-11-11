import { test, expect } from '@playwright/test';

// abcjs moves "ornaments" above a beamed up-stem group; the left-side arpeggio
// line must still span its own chord, whether beamed, unbeamed, treble or bass.
test('arpeggio lines span their own chord in beamed and unbeamed chords', async ({ page }) => {
  await page.goto('/tests/browser-engraving.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const cases = [
    'X:1\nL:1/8\nK:D\n!arpeggio![=CEB]2 z6|',
    'X:1\nL:1/8\nK:D\n!arpeggio![BE=C]A z6|',
    'X:1\nL:1/8\nK:D\n!arpeggio![A,CE]A z6|',
    'X:1\nL:1/8\nK:D\n!arpeggio![cea]A z6|',
    'X:1\nL:1/8\nK:D clef=bass\n!arpeggio![G,D,]G, z6|',
  ];
  for (const abc of cases) {
    const marks = await page.evaluate((text) => window.arpeggioGeometry(text), abc);
    expect(marks).toHaveLength(1);
    const [{ arp, heads }] = marks;
    // The line overlaps the noteheads and does not reach more than one
    // notehead height beyond them.
    const headHeight = (heads[1] - heads[0]) / 4 || 8;
    expect(arp[1]).toBeGreaterThan(heads[0]);
    expect(arp[0]).toBeLessThan(heads[1]);
    expect(arp[0]).toBeGreaterThan(heads[0] - 2 * headHeight);
    expect(arp[1]).toBeLessThan(heads[1] + 2 * headHeight);
  }
});
