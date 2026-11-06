import { describe, expect, it } from 'vitest';
import { expandedViewBox } from '../src/lib/engraving';

describe('engraving clipping protection', () => {
  it('expands dense lyrics to include the actual right edge', () => {
    const fitted = expandedViewBox(
      { x: 0, y: 0, width: 930, height: 650 },
      { x: 10, y: 20, width: 1040, height: 600 },
    );
    expect(fitted.width).toBeGreaterThanOrEqual(1062);
    expect(fitted.height).toBeGreaterThanOrEqual(650);
  });
  it('preserves non-zero system coordinates on later PDF pages', () => {
    const fitted = expandedViewBox(
      { x: 0, y: 650, width: 930, height: 550 },
      { x: 10, y: 670, width: 1000, height: 520 },
    );
    expect(fitted.y).toBe(650);
    expect(fitted.height).toBe(550);
    expect(fitted.y + fitted.height).toBe(1200);
  });
  it('uses consistent staff scale across all systems', () => {
    const fitted = expandedViewBox(
      { x: 0, y: 1200, width: 930, height: 550 },
      { x: 8, y: 1210, width: 880, height: 500 },
      1062,
    );
    expect(fitted.width).toBe(1062);
    expect(fitted.y).toBe(1200);
  });
});
