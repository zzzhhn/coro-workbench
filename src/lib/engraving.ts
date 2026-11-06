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
  compact: boolean;
  automatic: boolean;
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

function synchronizedGroups(notes: NoteEvent[]): EngravingGroup[] {
  const events = new Map<number, { add: NoteEvent[]; remove: NoteEvent[] }>();
  notes.forEach((note) => {
    for (const [time, key] of [
      [note.start, 'add'],
      [note.start + note.duration, 'remove'],
    ] as const) {
      if (!events.has(time)) events.set(time, { add: [], remove: [] });
      events.get(time)![key].push(note);
    }
  });
  const boundaries = [...events.keys()].sort((a, b) => a - b);
  const active = new Map<string, NoteEvent>();
  const groups: EngravingGroup[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    events.get(start)!.remove.forEach((note) => active.delete(note.id));
    events.get(start)!.add.forEach((note) => active.set(note.id, note));
    if (!active.size) continue;
    const sounding = [...active.values()].sort(
      (a, b) => (b.midi ?? -1) - (a.midi ?? -1) || a.start - b.start,
    );
    groups.push({ start, duration: boundaries[index + 1] - start, notes: sounding });
  }
  return groups;
}

// Chord synchronization reduces notation voices, not musical events. Repeated
// overlapping pitches remain in different layers so their note-offs stay distinct.
function compactLanes(notes: NoteEvent[]): EngravingGroup[][] {
  const layers: NoteEvent[][] = [];
  const endings: Map<number, number>[] = [];
  const pitched = notes
    .filter((note) => note.midi !== null)
    .sort((a, b) => a.start - b.start || b.duration - a.duration);
  for (const note of pitched) {
    let layer = endings.findIndex((ends) => (ends.get(note.midi!) ?? -Infinity) <= note.start + EPSILON);
    if (layer < 0) {
      layer = layers.length;
      layers.push([]);
      endings.push(new Map());
    }
    layers[layer].push(note);
    endings[layer].set(note.midi!, note.start + note.duration);
  }
  const result = layers.map(synchronizedGroups);
  const rests = notes.filter((note) => note.midi === null);
  if (rests.length) result.push(...groupNoteLanes(rests));
  return result.length ? result : [[]];
}

function meanPitch(groups: EngravingGroup[]): number {
  const notes = groups.flatMap((group) => group.notes).filter((note) => note.midi !== null);
  return notes.reduce((sum, note) => sum + note.midi!, 0) / (notes.length || 1);
}

export function createEngravingPlan(project: ScoreProject, partIds?: string[]): EngravingPlan {
  const parts = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  const staves: EngravingStaff[] = [];
  const warnings: string[] = [];
  let dense = false;
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
      let compact = false;
      let voices: Array<{ groups: EngravingGroup[]; sourceVoice?: string }>;
      if (namedVoices) {
        voices = sourceVoices.flatMap((sourceVoice) => {
          const subset = notes.filter((note) => (note.voice ?? '') === sourceVoice);
          const lanes = groupNoteLanes(subset);
          if (lanes.length > 2) {
            compact = true;
            return compactLanes(subset).map((groups) => ({ groups, sourceVoice: sourceVoice || undefined }));
          }
          return lanes.map((groups) => ({ groups, sourceVoice: sourceVoice || undefined }));
        });
      } else if (rawLanes.length > 2) {
        compact = true;
        voices = compactLanes(notes).map((groups) => ({ groups }));
      } else voices = rawLanes.map((groups) => ({ groups }));
      if (compact) {
        dense = true;
        warnings.push(
          `${part.name}：${rawLanes.length} 条重叠时值线改为带逐音延音线的同步和弦；未删除、缩短或移调任何音符。`,
        );
      }
      for (let offset = 0; offset < voices.length; offset += 2) {
        const number = offset ? nextStaff++ : definition.number;
        const selected = voices
          .slice(offset, offset + 2)
          .sort((a, b) => meanPitch(b.groups) - meanPitch(a.groups));
        const extra = offset > 0;
        if (extra) warnings.push(`${part.name}：独立同音或原谱声部较多，增加辅助谱表保留全部声部。`);
        const suffix = extra
          ? ` · ${number}`
          : definitions.length > 1
            ? staffIndex === 0
              ? ' · RH'
              : ' · LH'
            : '';
        staves.push({
          part,
          number,
          clef: definition.clef,
          name: part.name + suffix,
          shortName:
            part.shortName +
            (extra ? ` ${number}` : definitions.length > 1 ? (staffIndex === 0 ? ' RH' : ' LH') : ''),
          compact,
          automatic: inferredGrand || extra,
          voices: selected.map((voice, index) => ({
            ...voice,
            id:
              definitions.length === 1 && !extra
                ? `P${partIndex + 1}V${index + 1}`
                : `P${partIndex + 1}S${number}V${index + 1}`,
            ...(selected.length === 2 ? { stem: index === 0 ? ('up' as const) : ('down' as const) } : {}),
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
  type Pitch = { startTie?: object; endTie?: boolean; pitch: number; midipitch?: number };
  type Event = { el_type: string; startChar?: number; pitches?: Pitch[] };
  const occurrences = new Map<string, Array<{ pitch: Pitch; start: number; end: number }>>();
  for (const line of tune.lines)
    for (const staff of line.staff ?? [])
      for (const voice of staff.voices ?? [])
        for (const candidate of voice ?? []) {
          const event = candidate as Event;
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
