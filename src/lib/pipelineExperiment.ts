import type { NoteEvent, ScorePart, ScoreProject } from './types';
import type { MeasureRange } from './scoreWindow';

export const PRESENTATION_VERSION = 'ensemble-reading-ab-1';
export const LAYOUT_VERSION = 'bounded-reading-layout-ab-3';
const BOWED_PROGRAMS = new Set([40, 41, 42, 43, 44, 45, 48, 49]);

/** Explicitly selected model parts only; this is a reading view, not a rewrite. */
export function stringEnsembleView(source: ScoreProject, eligiblePartIds: string[]) {
  const selected = source.parts.filter(p => eligiblePartIds.includes(p.id)
    && BOWED_PROGRAMS.has(p.program) && p.role === 'instrument');
  const project = structuredClone(source);
  const provenance: Record<string, { partId: string; note: NoteEvent }> = {};
  if (selected.length < 2) return { project, provenance, groupedPartIds: [] as string[] };
  const selectedIds = new Set(selected.map(p => p.id));
  const ensemble: ScorePart = {
    ...structuredClone(selected[0]), id: 'reading-string-ensemble', name: '弦乐合奏', shortName: '弦乐',
    instrument: 'string_ensemble_1', program: 48, clef: 'treble',
    staves: [{ number: 1, clef: 'treble' }, { number: 2, clef: 'bass' }],
    notes: selected.flatMap(part => part.notes.map(note => {
      const id = JSON.stringify([part.id, note.id]);
      provenance[id] = { partId: part.id, note: structuredClone(note) };
      // Staff and voice are view assignments. Original part, written voice,
      // all performance fields and exact duplicate/unison observations survive.
      return { ...note, id, staff: note.midi !== null && note.midi < 60 ? 2 : 1, voice: undefined };
    })).sort((a, b) => a.start - b.start || (a.midi ?? 0) - (b.midi ?? 0)),
  };
  let inserted = false;
  project.parts = project.parts.flatMap(part => {
    if (!selectedIds.has(part.id)) return [part];
    if (inserted) return [];
    inserted = true;
    return [ensemble];
  });
  return { project, provenance, groupedPartIds: [...selectedIds] };
}

export function readableLayout(project: ScoreProject, range: MeasureRange, partIds: string[], width: number) {
  const beatsPerBar = project.timeSignature[0] * 4 / project.timeSignature[1];
  const left = (range.start - 1) * beatsPerBar, right = range.end * beatsPerBar;
  const selected = project.parts.filter(p => partIds.includes(p.id));
  const active = selected.filter(p => p.notes.some(n => n.midi !== null
    && n.start < right && n.start + n.duration > left));
  // An entirely silent window still shows one staff, with its rests.
  const visiblePartIds = (active.length ? active : selected.slice(0, 1)).map(p => p.id);
  let peakWeight = 0;
  for (const part of active) {
    for (let measure = range.start - 1; measure < range.end; measure++) {
      const notes = part.notes.filter(n => n.midi !== null
        && n.start >= measure * beatsPerBar && n.start < (measure + 1) * beatsPerBar);
      const columns = new Map<string, typeof notes>();
      for (const note of notes) {
        const key = note.start.toFixed(6);
        columns.set(key, [...(columns.get(key) ?? []), note]);
      }
      // Chord members share an attack column. Counting them as horizontal
      // events needlessly doubles the systems of a dense ensemble score.
      const weight = [...columns.values()].reduce((sum, column) => sum + 1
        + (column.some(n => n.duration < .25) ? 1 : 0)
        + Math.max(...column.map(n => n.lyric ? .6 * n.lyric.length : 0))
        + (column.some(n => n.arpeggio) ? .7 : 0)
        + Math.min(1, (column.length - 1) * .15), 0);
      peakWeight = Math.max(peakWeight, weight);
    }
  }
  const capacity = Math.max(18, (width - 150) / 11);
  const barsPerSystem = peakWeight * 4 <= capacity ? 4 : peakWeight * 2 <= capacity ? 2 : 1;
  return { visiblePartIds, barsPerSystem, staffSep: 60, systemSep: 46,
    hiddenRestingParts: selected.length - visiblePartIds.length };
}

export type ExperimentStage = 'vocal' | 'strings' | 'layout';
export type ReviewRecord = {
  experimentId: string;
  stage: ExperimentStage;
  firstBar: number;
  scope: 'focus' | 'full';
  candidateSide: 'A' | 'B';
  preferred: 'A' | 'B' | 'same' | 'unsure';
  confidence: 'confident' | 'tentative' | 'unsure';
  problems: string[];
  comment: string;
  reviewedAt: string;
  reviewedBy: 'human';
  revealed: boolean;
};

export function candidateSideFor(id: string, stage: ExperimentStage, firstBar: number): 'A' | 'B' {
  let hash = 2166136261;
  for (const c of `${id}:${stage}:${firstBar}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0) % 2 ? 'A' : 'B';
}

export function decodeReviewRecords(serialized: string | null): ReviewRecord[] {
  try {
    const parsed: unknown = JSON.parse(serialized ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is ReviewRecord => Boolean(r && typeof r === 'object'
      && typeof r.experimentId === 'string' && ['vocal', 'strings', 'layout'].includes(r.stage)
      && Number.isInteger(r.firstBar) && r.firstBar > 0 && ['focus', 'full'].includes(r.scope)
      && ['A', 'B'].includes(r.candidateSide) && ['A', 'B', 'same', 'unsure'].includes(r.preferred)
      && ['confident', 'tentative', 'unsure'].includes(r.confidence)
      && Array.isArray(r.problems) && r.problems.every((p: unknown) => typeof p === 'string')
      && typeof r.comment === 'string' && typeof r.reviewedAt === 'string'
      && r.reviewedBy === 'human' && typeof r.revealed === 'boolean'));
  } catch { return []; }
}

/** Descriptive only: windows in one song are correlated, not independent users. */
export function reviewSummary(records: ReviewRecord[], experimentId: string, stage: ExperimentStage) {
  const latest = new Map<string, ReviewRecord>();
  for (const r of records) if (r.experimentId === experimentId && r.stage === stage)
    latest.set(`${r.firstBar}:${r.scope}`, r);
  const items = [...latest.values()];
  return { reviewed: items.length,
    candidatePreferred: items.filter(r => r.preferred === r.candidateSide).length,
    baselinePreferred: items.filter(r => ['A', 'B'].includes(r.preferred) && r.preferred !== r.candidateSide).length,
    same: items.filter(r => r.preferred === 'same').length,
    unsure: items.filter(r => r.preferred === 'unsure').length,
    seriousIssues: items.filter(r => r.problems.some(p => ['missing', 'octave', 'reattack', 'unplayable'].includes(p))).length,
    automaticPromotion: false as const };
}
