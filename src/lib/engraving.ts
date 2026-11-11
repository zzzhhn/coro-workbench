import type { TuneObject } from 'abcjs';
import type { AbcRenderResult, Clef, NoteEvent, ScorePart, ScoreProject } from './types';

export interface EngravingGroup {
  start: number;
  duration: number;
  notes: NoteEvent[];
}

export interface EngravingVoice {
  id: string;
  sourceVoice?: string;
  groups: EngravingGroup[];
  stem?: 'up' | 'down';
}

export interface EngravingStaff {
  part: ScorePart;
  number: number;
  clef: Clef;
  name: string;
  shortName: string;
  voices: EngravingVoice[];
  automatic: boolean;
  auxiliary: boolean;
}

export interface EngravingPlan {
  staves: EngravingStaff[];
  warnings: string[];
  dense: boolean;
}

export function getNotationStaffs(part: ScorePart): NonNullable<ScorePart['staves']> {
  if (part.staves?.length)
    return part.staves.map((staff) => ({ ...staff })).sort((a, b) => a.number - b.number);
  const numbers = [...new Set([1, ...part.notes.map((note) => note.staff ?? 1)])].sort((a, b) => a - b);
  return numbers.map((number) => ({ number, clef: number === 1 ? part.clef : 'bass' }));
}

const EPSILON = 0.00001;

export function groupNoteLanes(notes: NoteEvent[]): EngravingGroup[][] {
  const groups: EngravingGroup[] = [];
  for (const note of [...notes].sort(
    (a, b) => a.start - b.start || b.duration - a.duration || (b.midi ?? -1) - (a.midi ?? -1),
  )) {
    const previous = groups.at(-1);
    if (
      previous &&
      Math.abs(previous.start - note.start) < EPSILON &&
      Math.abs(previous.duration - note.duration) < EPSILON &&
      note.midi !== null &&
      previous.notes[0].midi !== null &&
      !previous.notes.some((other) => other.midi === note.midi)
    )
      previous.notes.push(note);
    else groups.push({ start: note.start, duration: note.duration, notes: [note] });
  }
  return packNoteGroups(groups);
}

function packNoteGroups(groups: EngravingGroup[]): EngravingGroup[][] {
  const lanes: EngravingGroup[][] = [];
  const ends: number[] = [];
  for (const group of groups) {
    let index = ends.findIndex((end) => end <= group.start + EPSILON);
    if (index < 0) {
      index = lanes.length;
      lanes.push([]);
    }
    lanes[index].push(group);
    ends[index] = group.start + group.duration;
  }
  return lanes.length ? lanes : [[]];
}

function meanPitch(groups: EngravingGroup[]): number {
  const notes = groups.flatMap((group) => group.notes).filter((note) => note.midi !== null);
  return notes.reduce((sum, note) => sum + note.midi!, 0) / (notes.length || 1);
}

export function createEngravingPlan(
  project: ScoreProject,
  partIds?: string[],
  beatWindow?: { start: number; end: number },
): EngravingPlan {
  const parts = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  const staves: EngravingStaff[] = [];
  const warnings: string[] = [];
  let dense = false;
  const generatedLayering = project.source.kind === 'audio'
    && project.source.analysis?.quality?.decoderProfile === 'yourmt3';
  parts.forEach((part, partIndex) => {
    const pitched = part.notes.filter((note) => note.midi !== null);
    const low = Math.min(...pitched.map((note) => note.midi!));
    const high = Math.max(...pitched.map((note) => note.midi!));
    const laneCount = groupNoteLanes(part.notes).length;
    const keyboard =
      /piano|keyboard|harp|organ|钢琴|键盘|竖琴|管风琴/i.test(part.name + part.instrument) ||
      (part.program >= 0 && part.program <= 7 && part.role !== 'lead' && part.role !== 'bass');
    const inferredGrand =
      !part.staves?.length &&
      !part.notes.some((note) => note.staff !== undefined) &&
      part.clef !== 'percussion' &&
      part.role !== 'percussion' &&
      part.role !== 'lead' &&
      part.role !== 'bass' &&
      low < 55 &&
      high >= 64 &&
      (keyboard || laneCount > 2);
    const definitions = part.staves?.length
      ? [...part.staves].sort((a, b) => a.number - b.number)
      : inferredGrand
        ? [
            { number: 1, clef: 'treble' as const },
            { number: 2, clef: 'bass' as const },
          ]
        : getNotationStaffs(part);
    if (inferredGrand) warnings.push(`${part.name}：仅阅谱自动分为高、低音谱表，全部原始音符与音高保留。`);
    // A declared keyboard grand staff already identifies the two hands.
    // Additional rhythmic lanes are voices on that staff, not another hand.
    const declaredGrand = keyboard && part.staves?.length === 2 && part.role !== 'percussion';
    let nextStaff = Math.max(...definitions.map((staff) => staff.number)) + 1;
    definitions.forEach((definition, staffIndex) => {
      const notes = part.notes.filter((note) =>
        inferredGrand
          ? (note.midi !== null && note.midi < 60 ? 2 : 1) === definition.number
          : (note.staff ?? definitions[0].number) === definition.number,
      );
      const sourceVoices = [...new Set(notes.map((note) => note.voice ?? ''))];
      const namedVoices = sourceVoices.some(Boolean);
      const rawLanes = groupNoteLanes(notes);
      let voices: Array<{ groups: EngravingGroup[]; sourceVoice?: string }>;
      if (namedVoices) {
        voices = sourceVoices.flatMap((sourceVoice) => {
          const subset = notes.filter((note) => (note.voice ?? '') === sourceVoice);
          const lanes = groupNoteLanes(subset);
          return lanes.map((groups) => ({ groups, sourceVoice: sourceVoice || undefined }));
        });
      } else voices = rawLanes.map((groups) => ({ groups }));
      // Keep independent rhythms independent. Synchronizing all on/off
      // boundaries turns one held note into dozens of tied fragments.
      if (voices.length > 2) {
        dense = true;
        warnings.push(
          `${part.name}：独立节奏分层记谱，长音不随其他声部反复切分；未删除、缩短或移调任何音符。`,
        );
      }
      // The generated layer IDs separate runs from holds across the whole
      // track. Reuse a reading lane when those groups do not overlap inside
      // the current window, keeping the original written staff and note IDs.
      if (beatWindow && generatedLayering && !keyboard && voices.length > 2
          && sourceVoices.every((voice) => /^(held|run|low)-\d+$/.test(voice))) {
        const groups = voices.flatMap((voice) => voice.groups)
          .filter((group) => group.start < beatWindow.end - EPSILON
            && group.start + group.duration > beatWindow.start + EPSILON)
          .sort((a, b) => a.start - b.start || b.duration - a.duration);
        voices = packNoteGroups(groups).map((groups) => ({ groups }));
      }
      const voicesPerStaff = declaredGrand ? voices.length : 2;
      for (let offset = 0; offset < voices.length; offset += voicesPerStaff) {
        const number = offset ? nextStaff++ : definition.number;
        const selected = voices
          .slice(offset, offset + voicesPerStaff)
          .sort((a, b) => meanPitch(b.groups) - meanPitch(a.groups));
        const extra = offset > 0;
        if (extra) warnings.push(`${part.name}：独立同音或原谱声部较多，增加辅助谱表保留全部声部。`);
        const suffix = extra
          ? ` · ${number}`
          : definitions.length > 1
            ? staffIndex === 0
              ? (keyboard ? ' · RH' : ' · 高音部')
              : (keyboard ? ' · LH' : ' · 低音部')
            : '';
        staves.push({
          part,
          number,
          clef: definition.clef,
          name: part.name + suffix,
          shortName:
            part.shortName +
            (extra ? ` ${number}` : definitions.length > 1 ? (keyboard ? (staffIndex === 0 ? ' RH' : ' LH') : (staffIndex === 0 ? ' 高音部' : ' 低音部')) : ''),
          automatic: inferredGrand || extra,
          auxiliary: extra,
          voices: selected.map((voice, index) => ({
            ...voice,
            id:
              definitions.length === 1 && !extra
                ? `P${partIndex + 1}V${index + 1}`
                : `P${partIndex + 1}S${number}V${index + 1}`,
            ...(selected.length > 1 && index === 0 ? { stem: 'up' as const }
              : selected.length > 1 && index === selected.length - 1 ? { stem: 'down' as const } : {}),
          })),
        });
      }
    });
  });
  return { staves, warnings: [...new Set(warnings)], dense };
}

// abcjs 6.7.2 matches partial chord ties by array position rather than pitch.
// The canonical event IDs identify the actual continuation before engraving.
export function prepareEngravingTune(tune: TuneObject, result: AbcRenderResult): TuneObject {
  if (!result.noteSegments) return tune;
  for (const line of tune.lines) {
    if (!line.staff || line.staff.length !== result.staffLayout?.length) continue;
    type Staff = NonNullable<typeof line.staff>[number] & { brace?: 'start' | 'continue' | 'end'; bracket?: 'start' | 'continue' | 'end' };
    const original = line.staff as Staff[];
    const kept = original.map((staff, index) => ({ staff, layout: result.staffLayout![index] }))
      .filter(({ staff, layout }) => !layout.auxiliary || (staff.voices ?? []).some(voice =>
        voice.some(event => event.el_type === 'note' && 'pitches' in event && Boolean(event.pitches?.length))));
    if (kept.length === original.length) continue;
    const bracketed = original.some(staff => staff.bracket);
    kept.forEach(({ staff, layout }, index) => {
      delete staff.brace;
      delete staff.bracket;
      const peers = kept.filter(item => item.layout.partId === layout.partId);
      if (peers.length > 1) staff.brace = peers[0].staff === staff ? 'start' : peers.at(-1)!.staff === staff ? 'end' : 'continue';
      if (bracketed && kept.length > 1) staff.bracket = index === 0 ? 'start' : index === kept.length - 1 ? 'end' : 'continue';
    });
    line.staff = kept.map(item => item.staff);
  }
  type Pitch = { startTie?: object; endTie?: boolean; pitch: number; midipitch?: number };
  type Event = { el_type: string; startChar?: number; pitches?: Pitch[]; duration?: number;
    rest?: { type: string }; startTriplet?: number; endTriplet?: boolean; tripletMultiplier?: number; tripletR?: number };
  const occurrences = new Map<string, Array<{ pitch: Pitch; start: number; end: number }>>();
  for (const line of tune.lines)
    for (const staff of line.staff ?? [])
      for (const voice of staff.voices ?? [])
        for (const candidate of voice ?? []) {
          const event = candidate as Event;
          // abcjs only supplies heads/flags through 128th notes. Measured
          // polyphonic boundaries can be finer. Use a supported head with an
          // explicit single-event tuplet ratio; the engraving spacing is
          // unchanged, as are canonical timing and the selectable note map.
          if (event.el_type === 'note' && event.duration && event.duration < 1 / 128
              && !event.startTriplet && !['invisible', 'spacer'].includes(event.rest?.type ?? '')) {
            const actual = event.duration;
            const ticks = Math.max(1, Math.round(actual * 4 * 960));
            const divisor = (a: number, b: number): number => b ? divisor(b, a % b) : a;
            event.duration = 1 / 128;
            event.startTriplet = 30 / divisor(30, ticks);
            event.tripletMultiplier = actual * 128;
            event.tripletR = 1;
            event.endTriplet = true;
          }
          if (!event.pitches || event.startChar === undefined) continue;
          const segment = result.noteSegments[event.startChar];
          if (!segment) continue;
          event.pitches.forEach((pitch, index) => {
            if (segment.midiPitches?.[index] !== undefined) pitch.midipitch = segment.midiPitches[index];
            delete pitch.startTie;
            delete pitch.endTie;
            const noteId = segment.noteIds[index];
            if (!noteId) return;
            const key = `${segment.partId}\0${noteId}`;
            if (!occurrences.has(key)) occurrences.set(key, []);
            occurrences
              .get(key)!
              .push({ pitch, start: segment.start, end: segment.start + segment.duration });
          });
        }
  for (const segments of occurrences.values()) {
    segments.sort((a, b) => a.start - b.start);
    segments.forEach((segment, index) => {
      if (index > 0 && Math.abs(segments[index - 1].end - segment.start) < EPSILON)
        segment.pitch.endTie = true;
      if (index < segments.length - 1 && Math.abs(segments[index + 1].start - segment.end) < EPSILON)
        segment.pitch.startTie = {};
    });
  }
  return tune;
}

export interface EngravingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Opt-in reading correction: multi-voice staff names can sit above their staff
 * in abcjs 6.7.2. Match the rendered staff's line/voice identity, not note Y. */
export function alignEngravingStaffNames(systems: SVGSVGElement[]): number {
  let moved = 0;
  for (const svg of systems) {
    for (const label of svg.querySelectorAll<SVGTextElement>('text.abcjs-voice-name')) {
      if (label.hasAttribute('transform')) continue;
      const classes = [...label.classList];
      const line = classes.find(name => /^abcjs-l\d+$/.test(name));
      const voice = classes.find(name => /^abcjs-v\d+$/.test(name));
      if (!line || !voice) continue;
      const staff = svg.querySelector<SVGGElement>(`g.abcjs-staff.${line}.${voice}`);
      if (!staff) continue;
      const staffBox = staff.getBBox(), labelBox = label.getBBox();
      const delta = staffBox.y + staffBox.height / 2 - labelBox.y - labelBox.height / 2;
      if (Number.isFinite(delta) && Math.abs(delta) > 1) {
        label.setAttribute('transform', `translate(0 ${delta})`);
        moved++;
      }
    }
  }
  return moved;
}

/** abcjs 6.7.2 moves every "ornament" above a beamed note clear of its beam.
 * The left-side arpeggio line is also classed as an ornament, so on an
 * up-stemmed beamed chord each wavy segment is pushed above the beam, away
 * from the chord. Re-stack each note's arpeggio segments to span that note's
 * own noteheads. Pure SVG geometry: notes, timing and audio are unchanged. */
export function alignEngravingArpeggios(systems: SVGSVGElement[]): number {
  let moved = 0;
  for (const svg of systems) {
    for (const note of svg.querySelectorAll<SVGGElement>('g.abcjs-note')) {
      const segments = [...note.querySelectorAll<SVGPathElement>('path[data-name="scripts.arpeggio"]')];
      const heads = [...note.querySelectorAll<SVGGraphicsElement>('.abcjs-notehead')];
      if (!segments.length || !heads.length) continue;
      const headBoxes = heads.map(head => head.getBBox());
      const top = Math.min(...headBoxes.map(box => box.y));
      const bottom = Math.max(...headBoxes.map(box => box.y + box.height));
      const boxes = segments.map(segment => ({ segment, box: segment.getBBox() }))
        .sort((a, b) => b.box.y - a.box.y);
      const height = boxes[0].box.height;
      const currentTop = Math.min(...boxes.map(item => item.box.y));
      const currentBottom = Math.max(...boxes.map(item => item.box.y + item.box.height));
      // Already spanning its chord (unbeamed or stems-down): leave it alone.
      if (currentTop <= top + height && currentBottom >= bottom - height
          && currentTop >= top - height * 2 && currentBottom <= bottom + height * 2) continue;
      // Same stacking abcjs uses when the line is not displaced: one segment
      // per two staff steps (one notehead height), from half a notehead below
      // the lowest head to the top head, bottom segment first.
      const headHeight = headBoxes[0].height;
      const needed = Math.max(1, Math.floor((bottom - top) / headHeight) + 1);
      boxes.forEach(({ segment, box }, index) => {
        if (index >= needed) {
          segment.setAttribute('visibility', 'hidden');
          return;
        }
        const targetY = bottom + headHeight / 2 - height - index * headHeight;
        segment.setAttribute('transform', `translate(0 ${targetY - box.y})`);
      });
      moved++;
    }
  }
  return moved;
}

export function expandedViewBox(view: EngravingBox, ink: EngravingBox, sharedRight?: number): EngravingBox {
  const x = Math.min(view.x, ink.x - 3);
  const y = Math.min(view.y, ink.y - 3);
  const right = Math.max(view.x + view.width, ink.x + ink.width + 12, sharedRight ?? 0);
  const bottom = Math.max(view.y + view.height, ink.y + ink.height + 8);
  return { x, y, width: right - x, height: bottom - y };
}

// abcjs oneSvgPerLine uses absolute, non-zero Y view boxes. Dense lyrics may
// exceed its nominal width; expand to actual ink without resetting system Y.
export function fitEngravingSystems(systems: SVGSVGElement[]): EngravingBox[] {
  const geometry = systems.map((svg) => {
    const box = svg.getBBox();
    const view = svg.viewBox.baseVal;
    return {
      view: {
        x: view.x,
        y: view.y,
        width: view.width || Number(svg.getAttribute('width')) || 900,
        height: view.height || Number(svg.getAttribute('height')) || 300,
      },
      ink: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  });
  const sharedRight = Math.max(
    0,
    ...geometry.map(({ view, ink }) => Math.max(view.x + view.width, ink.x + ink.width + 12)),
  );
  return systems.map((svg, index) => {
    const box = expandedViewBox(geometry[index].view, geometry[index].ink, sharedRight);
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.display = 'block';
    return box;
  });
}
