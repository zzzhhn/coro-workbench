import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { createEngravingPlan } from '../src/lib/engraving';
import { toAbc, toMusicXml, fromMusicXml } from '../src/lib/music';
import type { ScoreProject } from '../src/lib/types';

describe('independent polyphonic rhythm', () => {
  it('does not reslice a held note at every boundary in other voices', () => {
    const project = createBlankProject();
    project.measures = 1;
    project.parts[0].notes = [
      { id: 'held', midi: 60, start: 0, duration: 4, velocity: .8 },
      { id: 'inner', midi: 64, start: 0, duration: 2, velocity: .8 },
      ...Array.from({ length: 16 }, (_, i) => ({ id: `run-${i}`, midi: 72 + i % 4,
        start: i / 4, duration: i === 15 ? .25 : .375, velocity: .8 })),
    ];
    const before = structuredClone(project);
    const segments = [...new Set(Object.values(toAbc(project).noteSegments!))];
    expect(segments.filter((s) => s.noteIds.includes('held'))).toHaveLength(1);
    expect(new Set(segments.flatMap((s) => s.noteIds)).size).toBe(18);
    expect(project).toEqual(before);
  });

  const path = 'data/p0-multiscore/full-songs/Track00009/project.json';
  it.skipIf(!existsSync(path))('does not multiply the frozen song events while assigning voices', () => {
    const project = JSON.parse(readFileSync(path, 'utf8')) as ScoreProject;
    const plan = createEngravingPlan(project);
    const occurrences = plan.staves.flatMap((s) => s.voices.flatMap((v) => v.groups.flatMap((g) => g.notes)));
    const expected = project.parts.reduce((sum, p) => sum + p.notes.length, 0);
    expect(occurrences).toHaveLength(expected);
  });

  const fixed = 'evidence/notation-repair/Track00009-final.json';
  it.skipIf(!existsSync(fixed))('checks the repaired complete song notation and exact XML round trip', () => {
    const project = JSON.parse(readFileSync(fixed, 'utf8')) as ScoreProject;
    const result = toAbc(project);
    const segments = [...new Set(Object.values(result.noteSegments!))];
    const headCount = segments.reduce((sum, s) => sum + s.noteIds.length, 0);
    const mallet = segments.filter((s) => s.partId === 'mallet-8');
    expect(headCount).toBeLessThan(4000);
    expect(new Set(segments.flatMap((s) => s.noteIds)).size).toBe(2694);
    const restored = fromMusicXml(toMusicXml(project));
    const rows = (p: ScoreProject) => p.parts.map(part => part.notes.filter(n => n.midi !== null).map(n =>
      [n.midi!, Math.round(n.start * 960), Math.round(n.duration * 960)])
      .sort((a,b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]));
    expect(rows(restored)).toEqual(rows(project));
    writeFileSync('evidence/notation-repair/density.json', JSON.stringify({
      canonical: 2694, beforeAbcNoteheads: 5807, afterAbcNoteheads: headCount,
      malletCanonical: 493, malletNoteheads: mallet.reduce((sum,s)=>sum+s.noteIds.length,0),
      arbitraryTupletTokens: (result.abc.match(/\((?!3:2:1)\d+:\d+:1/g) ?? []).length,
    }, null, 2));
  });
});
