// Source-image proof-reading: map between Coro measures/notes and regions on the
// original score pages, using project.source.omrReview (see omrReview.ts).
import type { ScoreProject } from './types';
import { beatsPerBar } from './music';
import { omrReviewOf, sourceRefOf, type Box, type OmrReview } from './omrReview';

export type { Box } from './omrReview';

export interface SourceRegion {
  page: number;
  measure: number;
  partIndex: number;
  box: Box;
  /** Measure box edges that were not snapped to a printed barline. */
  estimated: boolean;
  /** Approximate notehead anchor of the selected note, when known. */
  point?: [number, number];
}

export const measureOfBeat = (project: Pick<ScoreProject, 'timeSignature'>, beat: number): number =>
  Math.floor(beat / beatsPerBar(project) + 1e-6) + 1;

/**
 * OMR and Coro measure numbers usually agree, but an implicit pick-up bar or a
 * malformed measure can shift Coro's equal-length bars. Notes carry sourceRef,
 * so translate through the notes themselves and fall back to equal numbers.
 */
export function omrMeasureOf(project: ScoreProject, partIndex: number, scoreMeasure: number): number {
  const review = omrReviewOf(project);
  const part = project.parts[partIndex];
  if (!review || !part) return scoreMeasure;
  const bar = beatsPerBar(project);
  const refs = new Map(review.notes.map((item) => [item.ref, item.measure]));
  for (const note of part.notes) {
    const ref = sourceRefOf(note);
    if (ref && refs.has(ref) && measureOfBeat(project, note.start) === scoreMeasure) return refs.get(ref)!;
  }
  // No referenced note in this bar: offset from the nearest referenced bar.
  let best: { distance: number; delta: number } | undefined;
  for (const note of part.notes) {
    const ref = sourceRefOf(note);
    if (!ref || !refs.has(ref)) continue;
    const here = Math.floor(note.start / bar + 1e-6) + 1;
    const distance = Math.abs(here - scoreMeasure);
    if (!best || distance < best.distance) best = { distance, delta: refs.get(ref)! - here };
  }
  return scoreMeasure + (best?.delta ?? 0);
}

/** Inverse of omrMeasureOf: the Coro bar holding notes of an OMR measure. */
export function scoreMeasureOf(project: ScoreProject, partIndex: number, omrMeasure: number): number {
  const review = omrReviewOf(project);
  const part = project.parts[partIndex];
  if (!review || !part) return omrMeasure;
  const refs = new Set(
    review.notes
      .filter((item) => item.partIndex === partIndex && item.measure === omrMeasure)
      .map((item) => item.ref),
  );
  const note = part.notes.find((item) => refs.has(sourceRefOf(item) ?? ''));
  if (note) return measureOfBeat(project, note.start);
  let best: { distance: number; delta: number } | undefined;
  const byRef = new Map(review.notes.map((item) => [item.ref, item.measure]));
  for (const candidate of part.notes) {
    const ref = sourceRefOf(candidate);
    if (!ref || !byRef.has(ref)) continue;
    const distance = Math.abs(byRef.get(ref)! - omrMeasure);
    if (!best || distance < best.distance)
      best = { distance, delta: measureOfBeat(project, candidate.start) - byRef.get(ref)! };
  }
  return omrMeasure + (best?.delta ?? 0);
}

/**
 * Region for a measure of a part, plus the selected note's anchor if its
 * sourceRef is known. Without a part box, falls back to any part's box of that
 * measure (same system), so the view still lands near the right place.
 */
export function regionFor(
  project: ScoreProject,
  measure: number,
  partIndex: number | undefined,
  noteId?: string,
): SourceRegion | undefined {
  const review = omrReviewOf(project);
  if (!review) return undefined;
  const candidates = review.measures.filter((item) => item.measure === measure);
  const chosen = candidates.find((item) => item.partIndex === partIndex) ?? candidates[0];
  if (!chosen) return undefined;
  const note =
    partIndex !== undefined && noteId
      ? project.parts[partIndex]?.notes.find((item) => item.id === noteId)
      : undefined;
  const ref = sourceRefOf(note);
  const anchor = ref
    ? review.notes.find((item) => item.ref === ref && item.page === chosen.page)?.point
    : undefined;
  return {
    page: chosen.page,
    measure,
    partIndex: chosen.partIndex,
    box: chosen.box,
    estimated: chosen.edges.includes('estimated'),
    point: anchor ?? undefined,
  };
}

/** Union of all part boxes of one measure on one page: the whole system column. */
export function systemBox(review: OmrReview, page: number, measure: number): Box | undefined {
  const boxes = review.measures
    .filter((item) => item.page === page && item.measure === measure)
    .map((item) => item.box);
  if (!boxes.length) return undefined;
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

export interface SourceHit {
  measure: number;
  partIndex: number;
  /** Nearest approximate note anchor within the hit measure, mapped to a Coro note. */
  noteId?: string;
}

/** Typical staff height on a page, for distance tolerances (falls back to 60 px). */
function staffHeight(review: OmrReview, page: number): number {
  const heights = review.staves.filter((item) => item.page === page).map((item) => item.box[3] - item.box[1]);
  return heights.length ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] : 60;
}

/**
 * Reverse lookup from a click on page pixels back to a score measure and note.
 * Anchors are approximate (often 0.5-2 staff spaces off, and ledger-line notes
 * fall outside the staff band), so a nearby anchor wins over strict box
 * containment; otherwise the containing measure box is used.
 */
export function hitTest(project: ScoreProject, page: number, x: number, y: number): SourceHit | undefined {
  const review = omrReviewOf(project);
  if (!review) return undefined;
  const reach = staffHeight(review, page) * 0.6;
  const nearest = review.notes
    .filter((item) => item.page === page && item.point)
    .map((item) => ({ item, distance: Math.hypot(item.point![0] - x, item.point![1] - y) }))
    .sort((a, b) => a.distance - b.distance)[0];
  const noteFor = (partIndex: number, ref: string) =>
    project.parts[partIndex]?.notes.find((note) => sourceRefOf(note) === ref)?.id;
  if (nearest && nearest.distance <= reach)
    return {
      measure: nearest.item.measure,
      partIndex: nearest.item.partIndex,
      noteId: noteFor(nearest.item.partIndex, nearest.item.ref),
    };
  const inside = review.measures.filter(
    (item) =>
      item.page === page && x >= item.box[0] && x <= item.box[2] && y >= item.box[1] && y <= item.box[3],
  );
  // Padded boxes may overlap vertically: the one whose centre is closest wins.
  const hit = inside.sort(
    (a, b) => Math.abs((a.box[1] + a.box[3]) / 2 - y) - Math.abs((b.box[1] + b.box[3]) / 2 - y),
  )[0];
  if (!hit) return undefined;
  return { measure: hit.measure, partIndex: hit.partIndex };
}

/** Crop window around a box with context padding, clamped to the page. */
export function cropWindow(page: { width: number; height: number }, box: Box, padding = 0.35): Box {
  const [x0, y0, x1, y1] = box;
  const padX = Math.max(40, (x1 - x0) * padding);
  const padY = Math.max(40, (y1 - y0) * padding);
  return [
    Math.max(0, x0 - padX),
    Math.max(0, y0 - padY),
    Math.min(page.width, x1 + padX),
    Math.min(page.height, y1 + padY),
  ];
}

/** Page size from omrReview; undefined if the page has no review data. */
export function pageSize(project: ScoreProject, page: number): { width: number; height: number } | undefined {
  const review = omrReviewOf(project);
  const entry = review?.pages.find((item) => item.page === page);
  return entry ? { width: entry.width, height: entry.height } : undefined;
}
