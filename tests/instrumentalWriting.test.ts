import { expect, it } from 'vitest';
import { arrangeForVoices } from '../src/lib/arrange';
import { createBlankProject } from '../src/lib/demo';
import { condenseInstrumentalRepeats, writeInstrumentalLines } from '../src/lib/instrumentalWriting';

function song(rhythm: number[]) {
  const source = createBlankProject();
  const lead = source.parts[0];
  lead.notes = [{ id: 'entry', midi: 72, start: 28, duration: 2, velocity: .8 }];
  source.parts.push({ ...lead, id: 'keys', role: 'instrument', notes:
    Array.from({length: 7}, (_, bar) => rhythm.map((beat, i) => ({
      id: 'key-' + bar + '-' + i, start: 4 * bar + beat, duration: .5, midi: [60, 64, 67][i % 3], velocity: .65,
    }))).flat()
  });
  const base = arrangeForVoices(source, {preset: 'solo-satb', style: 'pop', difficulty: 'medium', transpose: 0, percussion: false, leadPartId: lead.id});
  return {source, base};
}

it('changes the sung instrumental attacks when only the source backing rhythm changes', () => {
  const intro = (rhythm: number[]) => {
    const {source, base} = song(rhythm);
    const frozen = structuredClone(base);
    const {project, gestures} = writeInstrumentalLines(source, base);
    expect(base).toEqual(frozen);
    expect(project.id).not.toBe(base.id);
    expect(project.parts[0]).toEqual(base.parts[0]);
    expect(project.parts[4]).toEqual(base.parts[4]);
    const carrier = project.parts.find(p => p.id === gestures[0].carrier)!;
    return carrier.notes.filter(n => n.start < 4 && n.midi !== null).map(n => n.start);
  };
  expect(intro([0, 1, 2])).toEqual([0, 1, 2]);
  expect(intro([.5, 2, 3.5])).toEqual([.5, 2, 3.5]);
});

it('keeps a short introduction and compresses only repeated lead-free material', () => {
  const {source, base} = song([0, 1, 2]);
  const compressed = condenseInstrumentalRepeats(source, base);
  expect(compressed.cuts.length).toBe(1);
  expect(compressed.project.parts[0].notes.filter(n=>n.midi !== null).map(n=>[n.midi,n.duration]))
    .toEqual(base.parts[0].notes.filter(n=>n.midi !== null).map(n=>[n.midi,n.duration]));
  source.parts[0].notes[0].start = 8;
  expect(condenseInstrumentalRepeats(source, base).cuts).toEqual([]);
});

it('keeps the original parts where the score supplies no usable backing line', () => {
  const {source, base} = song([0]);
  source.parts.pop();
  const {project, gestures} = writeInstrumentalLines(source, base);
  expect(gestures).toEqual([]);
  expect(project.parts).toEqual(base.parts);
});
