import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectFromOmr } from '../src/lib/import';
import { navigableIssues, nextIssue, reviewIssues } from '../src/lib/noteInput';
import {
  cropWindow,
  hitTest,
  measureOfBeat,
  omrMeasureOf,
  regionFor,
  scoreMeasureOf,
  systemBox,
} from '../src/lib/sourceMap';
import type { OmrJob, OmrReview, ScoreProject } from '../src/lib/types';

const fixture = (name: string, file: string) =>
  readFileSync(`tests/fixtures/omr-review/${name}/${file}`, 'utf8');
const load = (name: string, edit?: (review: OmrReview) => void): ScoreProject => {
  const review = JSON.parse(fixture(name, 'review.json')) as OmrReview;
  edit?.(review);
  const job: OmrJob = {
    id: 'a'.repeat(32),
    status: 'complete',
    progress: 100,
    stage: 'complete',
    message: '',
    musicxml: fixture(name, 'homr.musicxml'),
    source: { filename: `${name}.png`, engine: 'homr' },
    pageUrls: [`/api/omr/jobs/${'a'.repeat(32)}/pages/1`],
    review,
  };
  return projectFromOmr(job);
};

describe('score -> source image', () => {
  it('every twinkle note lands inside its own measure box with its anchor', () => {
    const project = load('twinkle');
    const review = project.source.omrReview!;
    for (const note of project.parts[0].notes) {
      const bar = measureOfBeat(project, note.start);
      const region = regionFor(project, omrMeasureOf(project, 0, bar), 0, note.id)!;
      expect(region.page).toBe(0);
      const [x0, , x1] = region.box;
      const anchor = review.notes.find((item) => item.ref === note.sourceRef)!.point!;
      expect(region.point).toEqual(anchor);
      // Anchors are approximate; allow a little slack beyond estimated edges.
      expect(anchor[0]).toBeGreaterThan(x0 - 30);
      expect(anchor[0]).toBeLessThan(x1 + 30);
    }
  });
  it('marks a measure whose box edge was estimated rather than snapped to a barline', () => {
    const project = load('twinkle');
    expect(regionFor(project, 1, 0)?.estimated).toBe(true);
    expect(
      project.source.omrReview!.measures.some((item) => item.edges.every((edge) => edge === 'barline')),
    ).toBe(true);
  });
  it('crop keeps context and stays on the page', () => {
    const project = load('airds-air');
    const page = project.source.omrReview!.pages[0];
    const box = systemBox(project.source.omrReview!, 0, 1)!;
    const crop = cropWindow(page, box, 0.12);
    expect(crop[0]).toBeGreaterThanOrEqual(0);
    expect(crop[2]).toBeLessThanOrEqual(page.width);
    expect(crop[0]).toBeLessThan(box[0]);
    expect(crop[3]).toBeGreaterThan(box[3]);
  });
  it('without review data nothing is invented: whole-page fallback', () => {
    const project = load('twinkle');
    delete project.source.omrReview;
    expect(regionFor(project, 1, 0)).toBeUndefined();
    expect(hitTest(project, 0, 300, 120)).toBeUndefined();
  });
});

describe('source image -> score', () => {
  it('clicking a note anchor selects that exact note (round trip over all notes)', () => {
    for (const name of ['twinkle', 'airds-air']) {
      const project = load(name);
      const review = project.source.omrReview!;
      let exact = 0;
      for (const item of review.notes) {
        const hit = hitTest(project, item.page, item.point![0], item.point![1]);
        const note = project.parts[item.partIndex].notes.find(
          (candidate) => candidate.sourceRef === item.ref,
        )!;
        if (hit?.noteId === note.id) exact++;
        // The bar always matches, even where two anchors sit close together.
        if (hit)
          expect(scoreMeasureOf(project, hit.partIndex, hit.measure)).toBe(
            measureOfBeat(project, note.start),
          );
      }
      // Every anchor maps back to its own note (no chords in these fixtures).
      expect(exact).toBe(review.notes.length);
    }
  });
  it('an anchor below the staff band (ledger note) still resolves to its note', () => {
    const project = load('twinkle');
    // omr-0-0 sits 11 px below its measure box (approximate attention centre).
    const hit = hitTest(project, 0, 255, 162)!;
    expect(project.parts[0].notes.find((note) => note.id === hit.noteId)?.sourceRef).toBe('omr-0-0');
  });
  it('a click outside any measure (title, margin) returns nothing', () => {
    expect(hitTest(load('airds-air'), 0, 5, 5)).toBeUndefined();
  });
  it('measure numbers translate through notes when the score bars are shifted', () => {
    const project = load('airds-air');
    // Simulate a one-bar shift (e.g. an extra bar inserted in front).
    const bar = 4;
    for (const note of project.parts[0].notes) note.start += bar;
    project.measures += 1;
    expect(omrMeasureOf(project, 0, 3)).toBe(2);
    expect(scoreMeasureOf(project, 0, 2)).toBe(3);
    const issue = reviewIssues(project).find(
      (item) => item.kind === 'measure-underfull' && item.message.startsWith('第 9 小节'),
    )!;
    expect(issue.measure).toBe(10);
  });
});

describe('one review queue with OMR reasons', () => {
  it('airds-air: four notation-caused underfull bars, in order, wording explains both causes', () => {
    const issues = reviewIssues(load('airds-air')).filter((item) => item.kind === 'measure-underfull');
    expect(issues.map((item) => item.measure)).toEqual([1, 9, 10, 18]);
    expect(issues.every((item) => item.severity === 'check')).toBe(true);
    expect(issues[0].message).toContain('可能是弱起或反复处的分割小节');
    expect(issues.every((item) => !/置信|confidence/.test(item.message))).toBe(true);
  });
  it('twinkle is clean: nothing to step through', () => {
    expect(navigableIssues(reviewIssues(load('twinkle')))).toEqual([]);
  });
  it('info items are listed but [ ] skips them unless filtered to; filter restricts stepping', () => {
    const project = load('airds-air', (review) => {
      review.issues.push({
        kind: 'text-attached',
        severity: 'info',
        page: 0,
        partIndex: 0,
        measure: 2,
        message: '歌词 “la” 已贴到音符',
      });
    });
    const all = reviewIssues(project);
    expect(all.some((item) => item.kind === 'text-attached')).toBe(true);
    const queue = navigableIssues(all);
    expect(queue.some((item) => item.kind === 'text-attached')).toBe(false);
    expect(navigableIssues(all, 'text-attached').map((item) => item.measure)).toEqual([2]);
    // Stepping measure-level items advances even though they select no note.
    const first = nextIssue(project, queue, undefined, 0, 1)!;
    const second = nextIssue(project, queue, undefined, 0, 1, first)!;
    expect([first.measure, second.measure]).toEqual([1, 9]);
    expect(nextIssue(project, queue, undefined, 0, -1, first)!.measure).toBe(18);
  });
  it('a no-anchor issue tied to a note selects that note', () => {
    const project = load('twinkle', (review) => {
      const target = review.notes[5];
      target.point = null;
      review.issues.push({
        kind: 'no-anchor',
        severity: 'check',
        page: 0,
        partIndex: 0,
        measure: target.measure,
        noteRef: target.ref,
        message: '这个音在原图上没有定位点',
      });
    });
    const issue = reviewIssues(project).find((item) => item.kind === 'no-anchor')!;
    const note = project.parts[0].notes.find((item) => item.id === issue.noteId)!;
    expect(note.sourceRef).toBe(project.source.omrReview!.notes[5].ref);
    expect(regionFor(project, issue.measure, 0, note.id)?.point).toBeUndefined();
  });
});
