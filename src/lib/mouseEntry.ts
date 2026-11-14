// Click-to-place note entry: map a point on the engraved staff to a pitch and
// a beat, then insert. Crescendo's main input is "pick a note tool, click the
// staff" (observed: 01-radial-note-menu-after-place.png). Independent
// implementation over Coro's ScoreProject and the abcjs SVG geometry.
import type { Clef, NoteEvent, ScoreProject } from './types';
import { beatsPerBar, normalizeKey } from './music';
import { editId, type Selection } from './editor';
import { voiceLane } from './rangeEdit';

const EPS = 1e-6;
const round = (beat: number) => Math.round(beat * 960) / 960;
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL = [0, 2, 4, 5, 7, 9, 11];

/** Diatonic index (C0 = 0, D0 = 1 ...) of the top staff line for each clef. */
const TOP_LINE: Record<Clef, number> = {
  treble: 5 * 7 + 3, // F5
  bass: 3 * 7 + 5, // A3
  alto: 4 * 7 + 4, // G4
  percussion: 5 * 7 + 3, // drawn like treble
};

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FIFTHS: Record<string, number> = {
  Cb: -7,
  Gb: -6,
  Db: -5,
  Ab: -4,
  Eb: -3,
  Bb: -2,
  F: -1,
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  'F#': 6,
  'C#': 7,
  Abm: -7,
  Ebm: -6,
  Bbm: -5,
  Fm: -4,
  Cm: -3,
  Gm: -2,
  Dm: -1,
  Am: 0,
  Em: 1,
  Bm: 2,
  'F#m': 3,
  'C#m': 4,
  'G#m': 5,
  'D#m': 6,
  'A#m': 7,
};
function keyAlter(key: string, letter: string): number {
  const fifths = FIFTHS[normalizeKey(key)] ?? 0;
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(letter) ? 1 : 0;
  if (fifths < 0) return [...SHARP_ORDER].reverse().slice(0, -fifths).includes(letter) ? -1 : 0;
  return 0;
}

/**
 * Pitch at a staff position. `step` counts half-spaces down from the top line
 * (0 = top line, 1 = top space, 8 = bottom line, negative = above the staff).
 * The key signature applies, as on paper.
 */
export function pitchAtStep(clef: Clef, step: number, key: string): number {
  const diatonic = TOP_LINE[clef] - Math.round(step);
  const octave = Math.floor(diatonic / 7);
  const index = ((diatonic % 7) + 7) % 7;
  const midi = (octave + 1) * 12 + NATURAL[index] + keyAlter(key, LETTERS[index]);
  return Math.max(0, Math.min(127, midi));
}

/** Staff step from a y coordinate, given the y of the top and bottom staff lines. */
export function stepAtY(y: number, topLine: number, bottomLine: number): number {
  const half = (bottomLine - topLine) / 8;
  return half > 0 ? Math.round((y - topLine) / half) + 0 : 0;
}

export interface BeatAnchor {
  x: number;
  beat: number;
}

/**
 * Beat at an x position by piecewise-linear interpolation between known
 * anchors (note glyphs and barlines in the same system), snapped to `grid`.
 * A click within `stick` px of an existing attack takes that attack's exact
 * beat (so triplets and chords line up).
 */
export function beatAtX(anchors: BeatAnchor[], x: number, grid: number, stick = 8): number | undefined {
  const points = [...anchors]
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.beat))
    .sort((a, b) => a.x - b.x || a.beat - b.beat);
  if (points.length < 2) return undefined;
  const near = points
    .filter((item) => Math.abs(item.x - x) <= stick)
    .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
  if (near && near !== points.at(-1)) return round(near.beat);
  if (x <= points[0].x) return round(points[0].beat);
  let raw = points.at(-1)!.beat;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    if (x <= b.x) {
      raw = b.x - a.x > EPS ? a.beat + ((x - a.x) / (b.x - a.x)) * (b.beat - a.beat) : a.beat;
      break;
    }
  }
  // Snap down: the click lands in the slot it is in, never past the last anchor (the system end).
  const lastBeat = points.at(-1)!.beat;
  const snapped = Math.floor(raw / grid + 0.25) * grid;
  return round(Math.max(points[0].beat, Math.min(snapped, lastBeat - grid)));
}

export interface PlaceTarget {
  partId: string;
  /** Notation staff number inside the part (1 unless the part has several). */
  staffNumber: number;
  beat: number;
  midi: number | null;
  duration: number;
  voice: 1 | 2 | 3 | 4;
}

export interface PlaceResult {
  project: ScoreProject;
  selection: Selection;
  /** What happened, for the status message. */
  kind: 'added' | 'chord' | 'replaced-rest' | 'existing';
}

const laneKey = (note: NoteEvent) => `${note.staff ?? 1}:${note.voice ?? '1'}`;

/**
 * Place a note (or rest) at a beat in one staff/voice lane:
 * - a note already sounding at that onset -> chord tone with the same length
 *   (Crescendo merges notes placed at one position into a chord);
 * - a rest starts there -> the rest is replaced; a longer rest keeps its remainder;
 * - otherwise a new note is added (overlaps are left for the review queue).
 */
export function placeNote(project: ScoreProject, target: PlaceTarget): PlaceResult {
  const next = structuredClone(project);
  const part = next.parts.find((item) => item.id === target.partId);
  if (!part) throw new Error('找不到这个声部。');
  const multiStaff =
    Boolean(part.staves && part.staves.length > 1) || part.notes.some((note) => note.staff !== undefined);
  const lane = voiceLane(part, multiStaff ? target.staffNumber : undefined, target.voice);
  const named = target.voice !== 1 || part.notes.some((note) => note.voice !== undefined);
  const fields: Pick<NoteEvent, 'staff' | 'voice'> = {
    ...(multiStaff ? { staff: target.staffNumber } : {}),
    ...(named ? { voice: lane.voice } : {}),
  };
  const key = `${fields.staff ?? 1}:${fields.voice ?? '1'}`;
  const beat = round(target.beat);
  const at = part.notes.filter((note) => laneKey(note) === key && Math.abs(note.start - beat) < EPS);
  const bar = beatsPerBar(project);
  let kind: PlaceResult['kind'] = 'added';
  let duration = round(target.duration);
  const rest = at.find((note) => note.midi === null);
  const sounding = at.filter((note) => note.midi !== null);
  if (target.midi !== null && sounding.length) {
    const same = sounding.find((note) => note.midi === target.midi);
    if (same) return { project, selection: { partId: part.id, noteId: same.id }, kind: 'existing' };
    duration = sounding[0].duration;
    kind = 'chord';
  } else if (rest) {
    part.notes = part.notes.filter((note) => note.id !== rest.id);
    if (rest.duration > duration + EPS)
      part.notes.push({
        ...rest,
        id: editId(),
        start: round(beat + duration),
        duration: round(rest.duration - duration),
      });
    kind = 'replaced-rest';
  }
  const note: NoteEvent = {
    id: editId(),
    midi: target.midi,
    start: beat,
    duration,
    velocity: 0.75,
    origin: 'manual',
    ...fields,
  };
  part.notes.push(note);
  part.notes.sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0));
  next.measures = Math.max(next.measures, Math.ceil((beat + duration - EPS) / bar));
  if (next.measures > 2048) throw new Error('工程最多支持 2048 小节。');
  next.updatedAt = new Date().toISOString();
  return { project: next, selection: { partId: part.id, noteId: note.id }, kind };
}
