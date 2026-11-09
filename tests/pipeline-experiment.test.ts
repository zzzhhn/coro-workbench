import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { ScoreProject, AbcRenderResult } from '../src/lib/types';
import { createBlankProject } from '../src/lib/demo';
import { toAbc } from '../src/lib/music';
import { stringEnsembleView, readableLayout, reviewSummary, decodeReviewRecords, type ReviewRecord } from '../src/lib/pipelineExperiment';

describe('isolated reading experiments', () => {
  it('prints author numbering without shifting canonical notes or their selection map', () => {
    const p = createBlankProject(); p.measures = 12;
    p.parts[0].notes = [{ id: 'attack', midi: 60, start: 36, duration: 1, velocity: .7 }];
    const source = structuredClone(p);
    const abc = toAbc(p, undefined, { measureRange: { start: 10, end: 11 }, measureNumberOffset: -1 });
    expect(abc.abc).toContain('%%setbarnb 9');
    expect(Object.values(abc.noteSegments ?? {}).some(n => n.start === 36 && n.noteIds.includes('attack'))).toBe(true);
    expect(p).toEqual(source);
  });
  it('preserves duplicate unisons, timing and original voice provenance; excludes harp and choir', () => {
    const p = createBlankProject();
    const template = p.parts[0];
    p.parts = [40, 41, 46, 53].map(program => ({ ...structuredClone(template), id: String(program),
      program, role: 'instrument', notes: [{ id: 'same-id', midi: 60, start: 0, duration: 6,
        velocity: .8, staff: 2, voice: 'independent', articulation: 'tenuto' }] }));
    const original = structuredClone(p);
    const view = stringEnsembleView(p, ['40', '41', '46', '53']);
    expect(p).toEqual(original);
    expect(view.project.parts.map(part => part.program)).toEqual([48, 46, 53]);
    expect(view.project.parts[0].notes).toHaveLength(2);
    expect(new Set(view.project.parts[0].notes.map(n => n.id)).size).toBe(2);
    expect(Object.values(view.provenance).map(x => x.note)).toEqual(p.parts.slice(0, 2).flatMap(x => x.notes));
    expect(view.project.parts[0].notes.map(n => [n.midi, n.start, n.duration, n.velocity, n.articulation]))
      .toEqual([[60, 0, 6, .8, 'tenuto'], [60, 0, 6, .8, 'tenuto']]);
  });
  it('keeps sustained notes entering a window and only hides fully resting parts', () => {
    const p = createBlankProject();
    p.measures = 8;
    p.parts[0].notes = [{ id: 'hold', midi: 60, start: 2, duration: 8, velocity: .7 }];
    p.parts.push({ ...structuredClone(p.parts[0]), id: 'resting', notes: [] });
    const frozen = structuredClone(p);
    const layout = readableLayout(p, { start: 2, end: 3 }, p.parts.map(x => x.id), 900);
    expect(layout.visiblePartIds).toEqual([p.parts[0].id]);
    expect(p).toEqual(frozen);
  });
  it('does not treat stacked chord members as separate horizontal attacks', () => {
    const p = createBlankProject();
    p.parts[0].notes = Array.from({length: 8}, (_, i) => [60,64,67,72].map((midi,j) =>
      ({id:`${i}-${j}`,midi,start:i*.5,duration:.5,velocity:.7}))).flat();
    expect(readableLayout(p, {start:1,end:4}, [p.parts[0].id], 1100).barsPerSystem).toBe(4);
  });
  it('does not count repeat judgments, stale versions or a winning vote as acceptance', () => {
    const r: ReviewRecord = { experimentId: 'one', stage: 'vocal', firstBar: 13, scope: 'focus', candidateSide: 'B',
      preferred: 'B', confidence: 'confident', problems: [], comment: '', reviewedAt: '', reviewedBy: 'human', revealed: false };
    const summary = reviewSummary([r, { ...r, preferred: 'A' }, { ...r, experimentId: 'old' }], 'one', 'vocal');
    expect(summary).toMatchObject({ reviewed: 1, candidatePreferred: 0, baselinePreferred: 1, automaticPromotion: false });
    expect(decodeReviewRecords(JSON.stringify([r]))).toEqual([r]);
    expect(decodeReviewRecords(JSON.stringify([r, { ...r, preferred: 'broken' }]))).toEqual([r]);
    expect(decodeReviewRecords('{broken')).toEqual([]);
    expect(decodeReviewRecords('{}')).toEqual([]);
  });
});

const privateFixture = new URL('../evidence/pipeline-ab-20261108/review.json', import.meta.url);
describe.skipIf(!existsSync(privateFixture))('frozen private song contracts', () => {
  it('preserves every visible note identity through ensemble grouping and layout in all windows', () => {
    const data = JSON.parse(readFileSync(privateFixture, 'utf8')) as { ensembleSource: ScoreProject };
    const source = data.ensembleSource, frozen = JSON.stringify(source);
    const view = stringEnsembleView(source, source.parts.map(p => p.id));
    expect(view.project.parts.flatMap(p => p.notes)).toHaveLength(source.parts.flatMap(p => p.notes).length);
    const ids = (result: AbcRenderResult, grouped = false) => new Set(Object.values(result.noteSegments ?? {})
      .flatMap(s => s.noteIds.map(id => grouped && view.provenance[id]
        ? JSON.stringify([view.provenance[id].partId, view.provenance[id].note.id])
        : JSON.stringify([s.partId, id]))));
    for (let first = 1; first <= 69; first += 4) {
      const range = { start: first + 1, end: Math.min(71, first + 4) };
      const baseline = toAbc(source, undefined, { measureRange: range });
      expect(ids(toAbc(view.project, undefined, { measureRange: range }), true)).toEqual(ids(baseline));
      const layout = readableLayout(source, range, source.parts.map(p => p.id), 1100);
      expect(ids(toAbc(source, layout.visiblePartIds, { ...layout, measureRange: range }))).toEqual(ids(baseline));
    }
    expect(JSON.stringify(source)).toBe(frozen);
  });
});
