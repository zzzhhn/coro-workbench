import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import abcjs from 'abcjs';
import { createBlankProject } from '../src/lib/demo';
import { toAbc, toMusicXml, fromMusicXml, toMidi, fromMidi } from '../src/lib/music';
import type { ScoreProject } from '../src/lib/types';
import { createEngravingPlan, groupNoteLanes } from '../src/lib/engraving';

it('retains the written staccato duration in XML and its sounding gate in MIDI', () => {
  const p = createBlankProject();
  p.parts[0].notes = [{ id: 'short', midi: 60, start: 0, duration: 1, velocity: .8, articulation: 'staccato' }];
  const xmlNote = fromMusicXml(toMusicXml(p)).parts[0].notes.find(n => n.midi === 60)!;
  expect(xmlNote.duration).toBe(1);
  expect(xmlNote.articulation).toBe('staccato');
  expect(fromMidi(Uint8Array.from(toMidi(p)).buffer).parts[0].notes[0].duration).toBeCloseTo(.45);
});

it('engraves a real triplet as one group of three while preserving its clock', () => {
  const p = createBlankProject();
  p.measures = 1;
  p.chords = [];
  p.parts[0].notes = [0, 1, 2].map(i => ({ id: `t${i}`, midi: 60 + i,
    start: i / 3, duration: 1 / 3, velocity: .8 }));
  const result = toAbc(p);
  expect(result.abc.match(/\(3:2:3/g)).toHaveLength(1);
  expect(result.abc).not.toContain('(3:2:1');
  const tune = abcjs.parseOnly(result.abc)[0];
  const events = tune.lines.flatMap(l => l.staff?.[0].voices?.[0] ?? []) as Array<{ el_type: string; duration?: number; startTriplet?: number; endTriplet?: boolean }>;
  const notes = events.filter(e => e.el_type === 'note');
  expect(notes[0].startTriplet).toBe(3);
  expect(notes[2].endTriplet).toBe(true);
  const restored = fromMusicXml(toMusicXml(p));
  expect(restored.parts[0].notes.filter(n => n.midi !== null).map(n => Math.round(n.duration * 960))).toEqual([320, 320, 320]);
});

for (const id of ['Track00009', 'Track00010', 'lussier']) {
  const path = `evidence/musical-rhythm/${id}-musical.json`;
  it.skipIf(!existsSync(path))(`exports musical ${id} without arbitrary tuplets or missing attacks`, () => {
    const p = JSON.parse(readFileSync(path, 'utf8')) as ScoreProject;
    const result = toAbc(p);
    const tuples = result.abc.match(/\(\d+:\d+:\d+/g) ?? [];
    expect(tuples.filter(t => !t.startsWith('(3:2:'))).toEqual([]);
    const segments = [...new Set(Object.values(result.noteSegments!))];
    expect(new Set(segments.flatMap(s => s.noteIds)).size).toBe(p.parts.reduce((s, p) => s + p.notes.length, 0));
    const restored = fromMusicXml(toMusicXml(p));
    const rows = (p: ScoreProject) => p.parts.map(part => part.notes.filter(n => n.midi !== null).map(n =>
      [n.midi, Math.round(n.start * 960), Math.round(n.duration * 960)])
      .sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]! || a[2]! - b[2]!));
    expect(rows(restored)).toEqual(rows(p));
    writeFileSync(`evidence/musical-rhythm/${id}.musicxml`, toMusicXml(p));
    writeFileSync(`evidence/musical-rhythm/${id}.abc`, result.abc);
    writeFileSync(`evidence/musical-rhythm/${id}-notation.json`, JSON.stringify({
      notes: p.parts.reduce((s, p) => s + p.notes.length, 0), heads: segments.reduce((s, v) => s + v.noteIds.length, 0),
      tupletTokens: tuples, staves: result.staffMap?.length,
      staffDensity: createEngravingPlan(p).staves.map(s => ({ part: s.part.id, number: s.number,
        voices: s.voices.length, notes: s.voices.reduce((n,v)=>n+v.groups.length,0) })),
      minimumLanes: p.parts.map(part=>({id:part.id,high:groupNoteLanes(part.notes.filter(n=>(n.staff ?? ((n.midi ?? 0)<60?2:1))===1)).length,
        low:groupNoteLanes(part.notes.filter(n=>(n.staff ?? ((n.midi ?? 0)<60?2:1))===2)).length})),
    }, null, 2));
  });
}
