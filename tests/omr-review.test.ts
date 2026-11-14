import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromMusicXml, toMusicXml, validateOmrReview, validateProject } from '../src/lib/music';
import { projectFromOmr } from '../src/lib/import';
import { parseProject, serializeProject } from '../src/lib/storage';
import type { OmrJob, OmrReview } from '../src/lib/types';

const fixture = (name: string, file: string) => readFileSync(`tests/fixtures/omr-review/${name}/${file}`, 'utf8');
const job = (name: string, review?: OmrReview): OmrJob => ({
  id: 'a'.repeat(32),
  status: 'complete',
  progress: 100,
  stage: 'complete',
  message: '',
  musicxml: fixture(name, 'homr.musicxml'),
  source: { filename: `${name}.png`, engine: 'homr' },
  pageUrls: [`/api/omr/jobs/${'a'.repeat(32)}/pages/1`],
  review: review ?? (JSON.parse(fixture(name, 'review.json')) as OmrReview),
});

describe('OMR review data', () => {
  it('public fixtures validate and point at notes that exist', () => {
    for (const name of ['twinkle', 'airds-air']) {
      const review = JSON.parse(fixture(name, 'review.json')) as OmrReview;
      expect(validateOmrReview(review)).toEqual([]);
      const refs = new Set(fromMusicXml(fixture(name, 'homr.musicxml')).parts.flatMap((p) => p.notes.map((n) => n.sourceRef)));
      expect(review.notes.every((n) => n.precision === 'approximate')).toBe(true);
      expect(review.notes.filter((n) => n.point).length).toBe(review.notes.length);
      expect(review.notes.every((n) => refs.has(n.ref))).toBe(true);
    }
  });

  it('import keeps the server note id as sourceRef and copies review onto the project', () => {
    const project = projectFromOmr(job('airds-air'));
    const notes = project.parts.flatMap((p) => p.notes);
    expect(notes.length).toBe(84);
    expect(notes.every((n) => /^omr-0-\d+$/.test(n.sourceRef ?? ''))).toBe(true);
    expect(new Set(notes.map((n) => n.sourceRef)).size).toBe(84);
    expect(project.source.omrReview?.issues.map((i) => [i.kind, i.measure])).toEqual([
      ['measure-underfull', 1], ['measure-underfull', 9], ['measure-underfull', 10], ['measure-underfull', 18],
    ]);
    expect(validateProject(project)).toEqual([]);
  });

  it('a tie keeps the first note sourceRef; review survives save/load; MusicXML export drops both', () => {
    const xml = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note id="omr-0-0"><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/></note>
      <note id="omr-0-1"><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/></note></measure></part></score-partwise>`;
    const project = fromMusicXml(xml);
    expect(project.parts[0].notes).toHaveLength(1);
    expect(project.parts[0].notes[0].sourceRef).toBe('omr-0-0');
    const omr = projectFromOmr(job('twinkle'));
    const loaded = parseProject(serializeProject(omr));
    expect(loaded.source.omrReview).toEqual(omr.source.omrReview);
    expect(loaded.parts[0].notes.map((n) => n.sourceRef)).toEqual(omr.parts[0].notes.map((n) => n.sourceRef));
    const exported = toMusicXml(loaded);
    expect(exported).not.toMatch(/omr-0-|sourceRef|omrReview/);
  });

  it('rejects malformed review data without losing the score', () => {
    const review = JSON.parse(fixture('twinkle', 'review.json')) as OmrReview;
    const broken = structuredClone(review);
    broken.measures[0].box = [10, 10, 5, 20];
    expect(validateOmrReview(broken).length).toBeGreaterThan(0);
    const tooMany = structuredClone(review);
    tooMany.issues = Array.from({ length: 20_001 }, () => ({ kind: 'no-anchor', severity: 'check', message: 'x' }));
    expect(validateOmrReview(tooMany).length).toBeGreaterThan(0);
    const confidence = structuredClone(review) as unknown as { notes: Array<Record<string, unknown>> };
    confidence.notes[0].precision = 'exact';
    expect(validateOmrReview(confidence).length).toBeGreaterThan(0);
    const outOfRange = structuredClone(review);
    outOfRange.pages[0].page = 3;
    const project = projectFromOmr(job('twinkle', outOfRange));
    expect(project.source.omrReview).toBeUndefined();
    expect(project.source.warnings.some((w) => w.includes('原图对照数据无效'))).toBe(true);
    expect(project.parts[0].notes).toHaveLength(28);
  });

  it('a dropped page link removes review data on load', () => {
    const omr = projectFromOmr(job('twinkle'));
    const text = serializeProject(omr).replace(`/api/omr/jobs/${'a'.repeat(32)}/pages/1`, 'https://example.com/page.png');
    const loaded = parseProject(text);
    expect(loaded.source.pages).toEqual([]);
    expect(loaded.source.omrReview).toBeUndefined();
  });

  it('sourceRef is bounded', () => {
    const project = projectFromOmr(job('twinkle'));
    project.parts[0].notes[0].sourceRef = 'x'.repeat(101);
    expect(validateProject(project).some((p) => p.includes('识谱音符引用'))).toBe(true);
  });
});
