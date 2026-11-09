import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMidi, toMusicXml, validateProject } from '../src/lib/music';
import { Midi } from '@tonejs/midi';
import type { ScoreProject } from '../src/lib/types';

function noteRows(project: ScoreProject) {
  return project.parts.map((part) => part.notes.filter((n) => n.midi !== null)
    .map((n) => [n.midi, Math.round(n.start * 960), Math.round(n.duration * 960)])
    .sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]! || a[2]! - b[2]!));
}
function checkXml(project: ScoreProject) {
  expect(validateProject(project)).toEqual([]);
  const xml = toMusicXml(project);
  const restored = fromMusicXml(xml);
  expect(restored.parts.map((p) => p.program)).toEqual(project.parts.map((p) => p.program));
  expect(noteRows(restored)).toEqual(noteRows(project));
  return xml;
}

it('preserves a written rolled chord in ABC and MusicXML without splitting it into tiny attacks', () => {
  const project=createBlankProject();
  project.parts[0].notes=[60,64,67].map((midi,index)=>({id:`roll-${index}`,midi,start:0,duration:2,velocity:.75,arpeggio:true}));
  expect(toAbc(project).abc).toContain('!arpeggio!');
  const xml=checkXml(project);
  expect(xml.match(/<arpeggiate\/>/g)).toHaveLength(3);
  expect(fromMusicXml(xml).parts[0].notes.filter(note=>note.midi!==null).every(note=>note.arpeggio)).toBe(true);
  const midi = new Midi(toMidi(project));
  const notes = [...midi.tracks[0].notes].sort((a, b) => a.midi - b.midi);
  expect(notes.map(note => note.ticks)).toEqual([0, 32, 64]);
  expect(notes.map(note => note.ticks + note.durationTicks)).toEqual(Array(3).fill(2 * midi.header.ppq));
});

for (const [variant, title] of [['readable', '空耳-记谱修正版'], ['candidate', '空耳-补音候选-未验收']]) {
it.skipIf(!existsSync(`data/p0-multiscore/private-konger/${variant}/project.json`))(`exports the private whole-song ${variant} without losing notes`,()=>{
  const project=JSON.parse(readFileSync(`data/p0-multiscore/private-konger/${variant}/project.json`,'utf8')) as ScoreProject;
  const xml=checkXml(project);
  writeFileSync(`evidence/konger/${title}.musicxml`,xml);
  const midi=toMidi(project);
  expect(new Midi(midi).tracks.reduce((sum,track)=>sum+track.notes.length,0)).toBe(project.parts.reduce((sum,part)=>sum+part.notes.length,0));
  writeFileSync(`evidence/konger/${title}.mid`,midi);
},30000);
}
describe('multi-instrument notation delivery', () => {
  it('preserves fine attacks, same-pitch overlaps, chords and class-specific staves in MusicXML', () => {
    const project = createBlankProject();
    project.parts = [40, 41, 42].map((program, i) => ({ ...structuredClone(project.parts[0]),
      id: `strings-${program}`, program, clef: (['treble', 'alto', 'bass'] as const)[i],
      notes: [
        { id: `long-${i}`, midi: 60, start: 3.99, duration: 1.2, velocity: .75 },
        { id: `again-${i}`, midi: 60, start: 4.01, duration: .03, velocity: .75 },
        { id: `chord-${i}`, midi: 67, start: 4.01, duration: .03, velocity: .75 },
      ],
    }));
    // Canonical 960 ticks per beat, including cross-bar ties.
    for (const p of project.parts) for (const n of p.notes) {
      n.start = Math.round(n.start * 960) / 960;
      n.duration = Math.round(n.duration * 960) / 960;
    }
    checkXml(project);
    const midi = new Midi(toMidi(project));
    expect(midi.tracks.map((t) => t.instrument.number)).toEqual([40, 41, 42]);
    expect(midi.tracks.map((t) => t.notes.length)).toEqual([3, 3, 3]);
  });
});

// Actual optional model output, never downloaded or substituted in CI.
for (const [id, dataset] of [['Track00009', 'full-songs'], ['Track00010', 'full-songs'], ['lussier', 'real-trio']]) {
  const path = `data/p0-multiscore/${dataset}/${id}/project.json`;
  it.skipIf(!existsSync(path))(`exports complete frozen ${id} without MusicXML note loss`, () => {
    const project = JSON.parse(readFileSync(path, 'utf8')) as ScoreProject;
    const xml = checkXml(project);
    writeFileSync(`evidence/${id}.musicxml`, xml);
    const midi = toMidi(project);
    expect(new Midi(midi).tracks.reduce((sum, t) => sum + t.notes.length, 0))
      .toBe(project.parts.reduce((sum, p) => sum + p.notes.length, 0));
    writeFileSync(`evidence/${id}.mid`, midi);
  }, 30000);
}
