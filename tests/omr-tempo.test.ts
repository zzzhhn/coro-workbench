import { expect, it } from 'vitest';
import { omrHasWrittenTempo, projectFromOmr } from '../src/lib/import';
import type { OmrJob } from '../src/lib/types';

const xml = (direction = '') =>
  `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${direction}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
const job = (musicxml: string, statistics: OmrJob['statistics'] = {}): OmrJob => ({
  id: 'j', status: 'complete', progress: 100, stage: 'complete', message: '', musicxml, statistics,
  warnings: ['乐谱里没有写入速度；导入时请确认或填写速度。'], source: { filename: 'score.pdf', engine: 'homr' },
});

it('asks for a tempo only when the recognized score states none', () => {
  expect(omrHasWrittenTempo(job(xml()))).toBe(false);
  expect(omrHasWrittenTempo(job(xml('<direction><sound tempo="88"/></direction>')))).toBe(true);
  expect(projectFromOmr(job(xml('<direction><sound tempo="88"/></direction>'))).tempo).toBe(88);
});

it('applies the confirmed tempo and drops the now-answered warning', () => {
  const project = projectFromOmr(job(xml()), 65);
  expect(project.tempo).toBe(65);
  expect(project.source.warnings.some((w) => w.includes('没有写入速度'))).toBe(false);
  expect(projectFromOmr(job(xml())).source.warnings.some((w) => w.includes('没有写入速度'))).toBe(true);
  expect(() => projectFromOmr(job(xml()), 2)).toThrow('10–500');
});
