import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { createDemoProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { prepareEngravingTune } from '../src/lib/engraving';
import {
  planSystems,
  repeatsOn,
  setRepeatRule,
  toggleSystemBreak,
  togglePageBreak,
  DEFAULT_LAYOUT,
} from '../src/lib/layout';
import { deleteMeasures, insertMeasures } from '../src/lib/measures';
import type { OmrJob, OmrReview, ScoreProject } from '../src/lib/types';
import { readFileSync } from 'node:fs';
import { projectFromOmr } from '../src/lib/import';

const systems = (p: ScoreProject) => toAbc(p).systemMeasures;

describe('system and page breaks', () => {
  it('default layout is unchanged: 4 bars per system', () => {
    expect(systems(createDemoProject())).toEqual([1, 5, 9, 13]);
  });
  it('a forced break ends the current system early; automatic systems resume after it', () => {
    const p = toggleSystemBreak(createDemoProject(), 3);
    expect(systems(p)).toEqual([1, 3, 7, 11, 15]);
    expect(systems(toggleSystemBreak(p, 3))).toEqual([1, 5, 9, 13]); // toggling off restores
  });
  it('a page break is also a system start and is reported as a page start', () => {
    const p = togglePageBreak(createDemoProject(), 9);
    const result = toAbc(p);
    expect(result.systemMeasures).toEqual([1, 5, 9, 13]);
    expect(result.pageStarts).toEqual([0, 2]);
    expect(planSystems({ ...DEFAULT_LAYOUT, pageBreaks: [6] }, 1, 16, () => 4)).toEqual({
      starts: [1, 5, 6, 10, 14],
      pageStarts: [0, 2],
    });
  });
  it('bar 1 cannot be a break; breaks must be inside the score', () => {
    expect(() => toggleSystemBreak(createDemoProject(), 1)).toThrow();
    const bad = { ...createDemoProject(), layout: { ...DEFAULT_LAYOUT, systemBreaks: [99] } };
    expect(validateProject(bad)).toContain('换行 / 换页小节无效。');
  });
  it('breaks travel through MusicXML as print new-system / new-page', () => {
    const p = togglePageBreak(toggleSystemBreak(createDemoProject(), 3), 9);
    const xml = toMusicXml(p);
    // MusicXML repeats <print> in every part's measure.
    expect(xml.match(/new-system="yes"/g)).toHaveLength(p.parts.length);
    expect(xml.match(/new-page="yes"/g)).toHaveLength(p.parts.length);
    const back = fromMusicXml(xml);
    expect(back.layout?.systemBreaks).toEqual([3]);
    expect(back.layout?.pageBreaks).toEqual([9]);
  });
  it('breaks stay with their music when bars are inserted or deleted', () => {
    const p = togglePageBreak(toggleSystemBreak(createDemoProject(), 5), 9);
    const inserted = insertMeasures(p, 3).project;
    expect([inserted.layout?.systemBreaks, inserted.layout?.pageBreaks]).toEqual([[6], [10]]);
    const deleted = deleteMeasures(p, 4, 6).project;
    expect([deleted.layout?.systemBreaks, deleted.layout?.pageBreaks]).toEqual([[4], [6]]);
  });
});

describe('clef, key and label repeat rules', () => {
  const lines = (p: ScoreProject) => {
    const result = toAbc(p);
    const tune = prepareEngravingTune(abcjs.parseOnly(result.abc)[0], result);
    return tune.lines
      .filter((line) => line.staff)
      .map((line) => {
        const staff = line.staff![0] as unknown as {
          clef: { type: string };
          key: { accidentals: unknown[] };
          title?: string[];
        };
        return [staff.clef.type !== 'none', staff.key.accidentals.length > 0, Boolean(staff.title?.[0])];
      });
  };
  it('every system (default): clef, key and names on every line', () => {
    expect(lines(createDemoProject())).toEqual(Array(4).fill([true, true, true]));
  });
  it('first system only', () => {
    let p = createDemoProject();
    for (const what of ['clef', 'key', 'labels'] as const) p = setRepeatRule(p, what, 'first');
    expect(lines(p)).toEqual([
      [true, true, true],
      [false, false, false],
      [false, false, false],
      [false, false, false],
    ]);
  });
  it('first system of each page; mixed rules', () => {
    let p = togglePageBreak(createDemoProject(), 9);
    p = setRepeatRule(setRepeatRule(p, 'clef', 'page'), 'labels', 'first');
    expect(lines(p)).toEqual([
      [true, true, true],
      [false, true, false],
      [true, true, false],
      [false, true, false],
    ]);
    expect(repeatsOn('page', 2, [0, 2])).toBe(true);
  });
});

describe('imported layout', () => {
  it('a multi-page OMR job keeps its page starts from the review even without new-page in MusicXML', () => {
    const dir = 'tests/fixtures/omr-review/airds-air';
    const review = JSON.parse(readFileSync(`${dir}/review.json`, 'utf8')) as OmrReview;
    // Pretend the second half of the tune was on a second page (same image reused).
    review.pages = [
      { ...review.pages[0], measureCount: 9 },
      { ...review.pages[0], page: 1, firstMeasure: 10, measureCount: 9 },
    ];
    review.measures = review.measures.map((m) => (m.measure >= 10 ? { ...m, page: 1 } : m));
    review.notes = review.notes.map((n) => (n.measure >= 10 ? { ...n, page: 1 } : n));
    review.staves = [...review.staves, ...review.staves.map((st) => ({ ...st, page: 1 }))];
    review.issues = review.issues.map((i) =>
      i.measure !== undefined && i.measure >= 10 ? { ...i, page: 1 } : i,
    );
    const job: OmrJob = {
      id: 'a'.repeat(32),
      status: 'complete',
      progress: 100,
      stage: 'complete',
      message: '',
      musicxml: readFileSync(`${dir}/homr.musicxml`, 'utf8'),
      source: { filename: 'airds-air.png', engine: 'homr' },
      pageUrls: [1, 2].map((n) => `/api/omr/jobs/${'a'.repeat(32)}/pages/${n}`),
      review,
    };
    const project = projectFromOmr(job);
    expect(project.layout?.pageBreaks).toEqual([10]);
    expect(toAbc(project).pageStarts?.length).toBe(2);
    expect(validateProject(project)).toEqual([]);
  });
});
