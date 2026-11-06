import type { ScorePart, ScoreProject } from '../lib/types';

export function partActivity(part: ScorePart, totalBeats: number, bins = 32): number[] {
  const activity = Array.from({ length: bins }, () => 0);
  if (totalBeats <= 0) return activity;
  const width = totalBeats / bins;
  for (const note of part.notes) {
    if (note.midi === null || note.velocity <= 0) continue;
    const first = Math.max(0, Math.floor(note.start / width));
    const last = Math.min(bins - 1, Math.floor((note.start + note.duration - 0.00001) / width));
    for (let bin = first; bin <= last; bin++) {
      activity[bin] += Math.max(
        0,
        Math.min(note.start + note.duration, (bin + 1) * width) - Math.max(note.start, bin * width),
      );
    }
  }
  const peak = Math.max(1, ...activity);
  return activity.map((value) => value / peak);
}

export function rehearsalSections(measures: number, length = 4): Array<{ start: number; end: number }> {
  return Array.from({ length: Math.ceil(measures / length) }, (_, index) => ({
    start: index * length + 1,
    end: Math.min(measures, (index + 1) * length),
  }));
}

export function partRange(part: ScorePart): [number, number] | undefined {
  let low = Infinity;
  let high = -Infinity;
  for (const note of part.notes)
    if (note.midi !== null) {
      low = Math.min(low, note.midi);
      high = Math.max(high, note.midi);
    }
  return Number.isFinite(low) ? [low, high] : undefined;
}

export function partRoleName(part: ScorePart): string {
  return { lead: '主旋律', harmony: '和声', bass: '低音', percussion: '节奏', instrument: '乐器' }[part.role];
}

export function overlapsUncertainSource(
  project: ScoreProject,
  partId: string,
  start: number,
  duration: number,
): boolean {
  const intervals = project.source.analysis?.uncertaintyIntervals;
  if (!intervals?.length || !project.originalAudio) return false;
  const part = project.parts.find((item) => item.id === partId);
  const tempo = project.originalAudio.tempo ?? project.tempo;
  const from = project.originalAudio.offsetSeconds + (start * 60) / tempo;
  const to = from + (duration * 60) / tempo;
  return intervals.some(
    (interval) =>
      (interval.partId === partId ||
        Boolean(
          project.arrangement &&
          part?.role === 'lead' &&
          interval.partId === project.arrangement.options.leadPartId,
        )) &&
      interval.startSeconds < to &&
      interval.endSeconds > from,
  );
}
