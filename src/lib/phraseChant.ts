import type { ChantAnchor } from './sourceChant';

const EPS = 1e-6;
export interface ChantRegion { start: number; end: number }
export interface PhraseChantBlock extends ChantRegion {
  pulse: number;
  breathEveryBars: number;
  exceptions: Array<{ start: number; reason: 'off-grid-harmony' | 'breath-conflicts-with-harmony' }>;
}

/** Plan a regular, quiet chordal backing, not an instrumental rhythm copy.
 * Harmony timing is immutable. Choose the slowest whole-beat pulse that fits
 * all structural arrivals in a block; retain off-beat changes as exceptions.
 * This is an opt-in chant policy, not a universal a-cappella style model. */
export function planPhraseChant(
  anchors: ChantAnchor[], coverage: ChantRegion[], spans: ChantRegion[],
  bar: number, tempo: number, blockBars = 4,
) {
  if (!Number.isInteger(blockBars) || blockBars < 4 || !Number.isFinite(bar) || bar < 1
    || !Number.isFinite(tempo) || tempo <= 0) throw Error('Invalid phrase chant timing');
  const blocks: PhraseChantBlock[] = [], breaths: ChantRegion[] = [];
  const events: Array<ChantRegion & { anchor: ChantAnchor }> = [];
  // Repeated breathing cycle chosen from elapsed time, not changing Solo gaps.
  const breathEveryBars = Math.max(1, Math.min(blockBars, Math.floor(6 / (bar * 60 / tempo))));
  const onGrid = (x: number, step: number) => Math.abs(x / step - Math.round(x / step)) < EPS;
  for (const span of spans) for (let start = span.start; start < span.end - EPS; start += blockBars * bar) {
    const end = Math.min(span.end, start + blockBars * bar);
    const local = anchors.filter(g => g.start < end && g.start + g.duration > start);
    const structural = local.filter(g => onGrid(g.start - start, 1));
    const pulse = [...new Set([bar, bar / 2, 1])].filter(p => p >= 1 && onGrid(bar, p))
      .sort((a, b) => b - a).find(p => structural.every(g => onGrid(g.start - start, p))) ?? 1;
    const block: PhraseChantBlock = { start, end, pulse, breathEveryBars, exceptions: [] };
    blocks.push(block);
    for (const g of local) if (!onGrid(g.start - start, pulse))
      block.exceptions.push({ start: g.start, reason: 'off-grid-harmony' });
    // One predictable release slot in every breathing cycle. A genuine short
    // harmony in that slot overrides the rest and is disclosed, never erased.
    for (let stop = start + breathEveryBars * bar; stop <= end + EPS; stop += breathEveryBars * bar) {
      const release = stop - Math.min(.5, pulse / 2);
      if (local.some(g => g.start >= release - EPS && g.start < stop - EPS))
        block.exceptions.push({ start: release, reason: 'breath-conflicts-with-harmony' });
      else breaths.push({ start: release, end: stop });
    }
    const grid = Array.from({ length: Math.ceil((end - start) / pulse) }, (_, i) => start + i * pulse);
    const cuts = [...new Set([start, end, ...grid,
      ...local.flatMap(g => [g.start, g.start + g.duration]),
      ...coverage.flatMap(c => [c.start, c.end]), ...breaths.flatMap(b => [b.start, b.end]),
    ].filter(t => t >= start && t <= end))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < EPS || !coverage.some(c => c.start <= a + EPS && c.end >= b - EPS)
        || breaths.some(r => r.start < b - EPS && r.end > a + EPS)) continue;
      const anchor = local.find(g => g.start <= a + EPS && g.start + g.duration >= b - EPS);
      // After a real source silence, wait for a fresh harmonic arrival.
      if (!anchor || coverage.some(c => c.start > anchor.start + EPS && c.start <= a + EPS && c.end >= b - EPS)) continue;
      events.push({ start: a, end: b, anchor });
    }
  }
  return { blocks, breaths, events };
}
