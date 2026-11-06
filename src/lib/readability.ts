import abcjs from 'abcjs';
import { toAbc, validateProject } from './music';
import { prepareEngravingTune } from './engraving';
import { reinterpretBeatUnit } from './scoreTools';
import type { ScoreProject } from './types';

export interface NotationReadabilitySummary {
  tempo: number;
  targetTempo: number;
  smallNotesBefore: number;
  smallNotesAfter: number;
  smallRestsBefore: number;
  smallRestsAfter: number;
  measuresBefore: number;
  measuresAfter: number;
  simultaneousOnsetExtrasBefore: number;
  simultaneousOnsetExtrasAfter: number;
  maximumPolyphonyBefore: number;
  maximumPolyphonyAfter: number;
  preservesPhysicalSeconds: true;
  partIds: string[];
  reason: string;
}

function collisionCounts(project: ScoreProject, partIds: string[]) {
  let maximumPolyphony = 0;
  let simultaneousOnsetExtras = 0;
  for (const part of project.parts) {
    if (!partIds.includes(part.id)) continue;
    const notes = part.notes.filter((note) => note.midi !== null);
    const onsets = new Map<number, number>();
    for (const note of notes) onsets.set(note.start, (onsets.get(note.start) ?? 0) + 1);
    simultaneousOnsetExtras += [...onsets.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    let active = 0;
    const events = notes
      .flatMap((note) => [
        [note.start, 1],
        [note.start + note.duration, -1],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, change] of events) {
      active += change;
      maximumPolyphony = Math.max(maximumPolyphony, active);
    }
  }
  return { maximumPolyphony, simultaneousOnsetExtras };
}

function shortGlyphs(project: ScoreProject, partIds: string[]) {
  const result = toAbc(project, partIds);
  const parsed = abcjs.parseOnly(result.abc);
  if (parsed.length !== 1 || parsed[0].warnings?.length) return undefined;
  const tune = prepareEngravingTune(parsed[0], result);
  let smallNotes = 0;
  let smallRests = 0;
  for (const line of tune.lines)
    for (const staff of line.staff ?? [])
      for (const voice of staff.voices ?? []) {
        let multiplier = 1;
        for (const item of voice ?? []) {
          if (!item || item.el_type !== 'note') continue;
          const event = item as unknown as {
            startChar?: number;
            duration?: number;
            startTriplet?: number;
            endTriplet?: boolean;
            tripletMultiplier?: number;
            pitches?: unknown[];
            rest?: { type?: string };
          };
          if (event.startTriplet) multiplier = event.tripletMultiplier ?? 1;
          const duration =
            event.startChar !== undefined && result.noteSegments?.[event.startChar]
              ? result.noteSegments[event.startChar].duration
              : (event.duration ?? 0) * 4 * multiplier;
          if (duration > 0 && duration < 0.25 - 1e-8) {
            if (event.pitches?.length) smallNotes++;
            else if (event.rest && event.rest.type !== 'spacer') smallRests++;
          }
          if (event.endTriplet) multiplier = 1;
        }
      }
  return { smallNotes, smallRests };
}

function exactSeconds(original: ScoreProject, projection: ScoreProject): boolean {
  if (original.parts.length !== projection.parts.length) return false;
  return original.parts.every((part, index) => {
    const next = projection.parts[index];
    if (part.id !== next.id || part.notes.length !== next.notes.length) return false;
    return part.notes.every((note, noteIndex) => {
      const candidate = next.notes[noteIndex];
      if (note.id !== candidate.id || note.midi !== candidate.midi) return false;
      if (
        Math.abs(note.start / original.tempo - candidate.start / projection.tempo) > 1e-10 ||
        Math.abs(note.duration / original.tempo - candidate.duration / projection.tempo) > 1e-10
      )
        return false;
      if (original.originalAudio && projection.originalAudio) {
        const before =
          (note.start * 60) / (original.originalAudio.tempo ?? original.tempo) +
          original.originalAudio.offsetSeconds;
        const after =
          (candidate.start * 60) / (projection.originalAudio.tempo ?? projection.tempo) +
          projection.originalAudio.offsetSeconds;
        if (Math.abs(before - after) > 1e-8) return false;
      }
      return true;
    });
  });
}

/** A reversible manual suggestion, never a tempo estimator or automatic edit.
 * smallNotes counts written note/chord groups; smallRests excludes invisible spacers.
 */
export function notationReadabilitySummary(
  project: ScoreProject,
  partIds?: string[],
): NotationReadabilitySummary | undefined {
  if (validateProject(project).length || project.measures * 2 > 2048) return undefined;
  if (!Number.isFinite(project.tempo) || project.tempo >= 90 || project.tempo * 2 > 180) return undefined;
  if (project.originalAudio && (project.originalAudio.tempo ?? project.tempo) * 2 > 500) return undefined;
  const selected = project.parts
    .filter((part) => !partIds || partIds.includes(part.id))
    .map((part) => part.id);
  if (!selected.length || partIds?.some((id) => !selected.includes(id))) return undefined;
  const before = shortGlyphs(project, selected);
  if (!before || before.smallNotes + before.smallRests === 0) return undefined;
  const doubled = reinterpretBeatUnit(project, 2).project;
  const after = shortGlyphs(doubled, selected);
  if (
    !after ||
    after.smallNotes + after.smallRests >= before.smallNotes + before.smallRests ||
    !exactSeconds(project, doubled)
  )
    return undefined;
  const beforeCollisions = collisionCounts(project, selected);
  const afterCollisions = collisionCounts(doubled, selected);
  return {
    tempo: project.tempo,
    targetTempo: doubled.tempo,
    smallNotesBefore: before.smallNotes,
    smallNotesAfter: after.smallNotes,
    smallRestsBefore: before.smallRests,
    smallRestsAfter: after.smallRests,
    measuresBefore: project.measures,
    measuresAfter: doubled.measures,
    simultaneousOnsetExtrasBefore: beforeCollisions.simultaneousOnsetExtras,
    simultaneousOnsetExtrasAfter: afterCollisions.simultaneousOnsetExtras,
    maximumPolyphonyBefore: beforeCollisions.maximumPolyphony,
    maximumPolyphonyAfter: afterCollisions.maximumPolyphony,
    preservesPhysicalSeconds: true,
    partIds: selected,
    reason: `仅改变记谱拍点单位：短于十六分音符的音符组 ${before.smallNotes}→${after.smallNotes}、可见休止符 ${before.smallRests}→${after.smallRests}；音符数量、音高及播放秒数不变，小节数 ${project.measures}→${doubled.measures}。这不是确认原曲速度或自动量化，请预览后决定。`,
  };
}
