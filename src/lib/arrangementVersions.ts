import { arrangeForVoices, inspectArrangement } from './arrange';
import { beatsPerBar, newId, validateProject } from './music';
import type { ArrangementOptions, MeasureLock, NoteEvent, ScoreProject } from './types';

interface Interval { start: number; end: number }

function union(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of intervals.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Keep complete accepted events, including an attack or release outside the
 * barline. Newly generated notes may only sound in the remaining time. */
function restoreEvents<T extends {start: number; duration: number}>(old: T[], generated: T[], ranges: Interval[],
  prepare?: (event: T, kept: T[]) => T) {
  const kept = old.filter(n => ranges.some(r => n.start < r.end && n.start + n.duration > r.start));
  const reserved = union([...ranges, ...kept.map(n => ({ start: n.start, end: n.start + n.duration }))]);
  const result = structuredClone(kept);
  for (const n of generated) {
    let from = n.start;
    const end = from + n.duration;
    const append = (to: number) => {
      if (to <= from + 1e-8) return;
      const event = { ...n, start: from, duration: from === n.start && to === end ? n.duration : to - from };
      result.push(prepare ? prepare(event, kept) : event);
    };
    for (const r of reserved) {
      if (r.end <= from) continue;
      if (r.start >= end) break;
      append(r.start);
      from = Math.max(from, r.end);
      if (from >= end) break;
    }
    append(end);
  }
  return result.sort((a, b) => a.start - b.start);
}

function restoreNotes(old: NoteEvent[], generated: NoteEvent[], ranges: Interval[]) {
  let ids: Set<string> | undefined;
  return restoreEvents(old, generated, ranges, (event, kept) => {
    ids ??= new Set(kept.map(n => n.id));
    if (ids.has(event.id)) event.id = newId('note');
    ids.add(event.id);
    return event;
  });
}

function musicalContent(project: ScoreProject) {
  return JSON.stringify(project.parts.map(p => [
    p.id, p.program, p.clef, p.notes.map(({ id: _id, ...event }) => event),
  ]));
}

export function generateArrangementVersion(source: ScoreProject, options: ArrangementOptions, current?: ScoreProject, other?: ScoreProject) {
  const next = arrangeForVoices(source, options);
  const meta = next.arrangement!;
  const previous = current?.arrangement;
  const locks: MeasureLock[] = previous?.locks ?? [];
  if (current && previous && locks.length) {
    if (current.key !== next.key || current.tempo !== next.tempo || current.measures !== next.measures ||
        String(current.timeSignature) !== String(next.timeSignature) || previous.options.preset !== options.preset ||
        previous.options.transpose !== options.transpose || previous.options.leadPartId !== meta.options.leadPartId ||
        next.parts.length !== current.parts.length || next.parts.some(p => !current.parts.some(old => old.id === p.id)))
      throw new Error('原谱的调、速度、小节或声部已改变。请先解除段落锁定，再用新设置编配。');
    const bar = beatsPerBar(next);
    const ranges = locks.map(lock => ({ start: (lock.first - 1) * bar, end: lock.last * bar }));
    next.chords = restoreEvents(current.chords, next.chords, ranges);
    for (const part of next.parts) {
      const old = current.parts.find(p => p.id === part.id)!;
      part.notes = restoreNotes(old.notes, part.notes, ranges);
    }
    meta.locks = structuredClone(locks);
    const report = inspectArrangement(next);
    meta.report = { ...report, changes: meta.report.changes };
  }
  const identical = !!current && musicalContent(next) === musicalContent(current) &&
    next.tempo === current.tempo && next.key === current.key && next.measures === current.measures &&
    String(next.timeSignature) === String(current.timeSignature) && JSON.stringify(next.chords) === JSON.stringify(current.chords);
  meta.revision = identical ? previous?.revision ?? 1 : 1 + Math.max(current ? previous?.revision ?? 1 : 0, other?.arrangement?.revision ?? 0);
  if (identical && current) next.id = current.id;
  const errors = validateProject(next);
  if (errors.length) throw new Error(errors.join('；'));
  return { project: next, identical };
}
