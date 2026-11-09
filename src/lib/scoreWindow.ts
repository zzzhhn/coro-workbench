export interface MeasureRange {
  start: number;
  end: number;
}

/** A reading window uses the same one-based measure numbers as the transport. */
export function scoreWindow(measures: number, bar: number, size: number): MeasureRange {
  const current = Math.max(1, Math.min(measures, bar));
  const start = Math.floor((current - 1) / size) * size + 1;
  return { start, end: Math.min(measures, start + size - 1) };
}
