import type { AbsoluteElement, TuneObject } from 'abcjs';
import { metronomeGrid } from '../src/lib/audio';
import type { AbcRenderResult, ScoreProject } from '../src/lib/types';

export interface TimelineSegment {
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
}

interface BeatAnchor {
  beat: number;
  x: number;
}

export interface ScoreSystem {
  svg: SVGSVGElement;
  firstBar: number;
  lastBar: number;
  top: number;
  bottom: number;
  anchors: BeatAnchor[][];
}

interface StaffGroup {
  startx: number;
  staffs: Array<{ topLine?: number; bottomLine?: number }>;
  voices: Array<{ children: AbsoluteElement[] }>;
}

type ScoreClock = Pick<ScoreProject, 'measures' | 'tempo' | 'timeSignature'>;
const BEAT_EPSILON = 1e-7;

function segmentEnd(segment: TimelineSegment): number {
  return segment.targetStart + segment.sourceEnd - segment.sourceStart;
}

/** Both clocks use quarter beats. A cut seeks to the next retained beat when possible. */
export function mappedVersionTime(
  time: number,
  from: ScoreClock,
  to: ScoreClock,
  fromSegments?: readonly TimelineSegment[],
  toSegments?: readonly TimelineSegment[],
): number {
  if (!fromSegments?.length && !toSegments?.length) return time;
  const beat = time * from.tempo / 60;
  const nextSegment = fromSegments?.findIndex(segment => segment.targetStart > beat + BEAT_EPSILON) ?? -1;
  const fromSegment = nextSegment === 0 ? undefined : fromSegments?.at(nextSegment < 0 ? -1 : nextSegment - 1);
  const sourceBeat = fromSegment
    ? Math.min(fromSegment.sourceEnd, fromSegment.sourceStart + Math.max(0, beat - fromSegment.targetStart))
    : fromSegments?.[0]?.sourceStart ?? beat;
  const retained = toSegments?.find(segment => sourceBeat < segment.sourceEnd - BEAT_EPSILON);
  const targetBeat = retained
    ? retained.targetStart + Math.max(0, sourceBeat - retained.sourceStart)
    : toSegments?.length ? segmentEnd(toSegments[toSegments.length - 1]) : sourceBeat;
  const end = to.measures * metronomeGrid(to).measure;
  return Math.max(0, Math.min(targetBeat, end)) * 60 / to.tempo;
}

export function playbackPosition(time: number, score: ScoreClock) {
  const { measure, step } = metronomeGrid(score);
  const beat = Math.min(score.measures * measure, Math.max(0, time * score.tempo / 60));
  const bar = Math.min(score.measures, Math.floor((beat + BEAT_EPSILON) / measure) + 1);
  const pulse = Math.min(Math.round(measure / step), Math.floor((beat - (bar - 1) * measure + BEAT_EPSILON) / step) + 1);
  return { beat, bar, pulse };
}

export function playheadX(anchors: readonly BeatAnchor[], beat: number): number {
  const nextIndex = anchors.findIndex(anchor => anchor.beat > beat);
  if (nextIndex < 0) return anchors[anchors.length - 1].x;
  const next = anchors[nextIndex];
  if (nextIndex === 0) return next.x;
  const previous = anchors[nextIndex - 1];
  return previous.x + (next.x - previous.x) * (beat - previous.beat) / (next.beat - previous.beat);
}

/** ABCJS lays out each system in its own SVG. Read the actual columns and barlines
 * in that SVG space, so the cursor remains aligned at every viewport scale. */
export function readScoreSystems(
  svgs: SVGSVGElement[],
  tune: TuneObject,
  result: AbcRenderResult,
  score: ScoreClock,
): ScoreSystem[] {
  const groups = (tune.engraver?.staffgroups ?? []) as StaffGroup[];
  const measure = metronomeGrid(score).measure;
  const starts = result.systemMeasures ?? [];
  return svgs.filter(svg => svg.querySelector('.abcjs-staff')).map((svg, index) => {
    const group = groups[index];
    const firstBar = starts[index];
    const lastBar = (starts[index + 1] ?? score.measures + 1) - 1;
    const guide = group.voices[0].children;
    const barlines = guide.filter(item => item.type === 'bar').map(item => item.x);
    const firstColumn = Math.max(group.startx, ...guide.filter(item => item.type.startsWith('staff-extra')).map(item => item.x + item.w));
    const attacks = Array.from({ length: lastBar - firstBar + 1 }, () => new Map<number, number>());
    for (const voice of group.voices) {
      let barIndex = 0;
      let beat = (firstBar - 1) * measure;
      for (const item of voice.children) {
        if (item.type === 'bar') {
          beat = (firstBar - 1 + ++barIndex) * measure;
          continue;
        }
        if (!['note', 'rest'].includes(item.type) || !attacks[barIndex]) continue;
        const rest = item.abcelem.rest?.type;
        // Whole-bar rests are drawn at the centre, independently of their metrical onset.
        if (!item.invisible && !['whole', 'multimeasure', 'invisible', 'spacer'].includes(rest ?? '')) {
          const character = item.abcelem.startChar;
          const start = (character === undefined ? undefined : result.noteSegments?.[character]?.start) ?? beat;
          const rounded = Math.round(start * 1e6) / 1e6;
          const bag = attacks[barIndex];
          bag.set(rounded, Math.min(item.x, bag.get(rounded) ?? Infinity));
        }
        beat += item.durationClass * 4;
      }
    }
    const staffEdges = group.staffs.flatMap(staff => [staff.topLine, staff.bottomLine])
      .filter((value): value is number => value !== undefined && Number.isFinite(value));
    const view = svg.viewBox.baseVal;
    const anchors = attacks.map((points, i) => {
      const start = (firstBar - 1 + i) * measure;
      const end = start + measure;
      const right = barlines[i] ?? view.x + view.width - 14;
      const left = Math.min(right, points.get(start) ?? (barlines[i - 1] ?? firstColumn) + 5);
      const columns = [{ beat: start, x: left }];
      for (const [beat, x] of [...points].sort(([a], [b]) => a - b)) {
        if (start < beat && beat < end && columns[columns.length - 1].x < x && x < right)
          columns.push({ beat, x });
      }
      columns.push({ beat: end, x: right });
      return columns;
    });
    return {
      svg, firstBar, lastBar, anchors,
      top: staffEdges.length ? Math.min(...staffEdges) - 4 : view.y + 4,
      bottom: staffEdges.length ? Math.max(...staffEdges) + 4 : view.y + view.height - 4,
    };
  });
}
