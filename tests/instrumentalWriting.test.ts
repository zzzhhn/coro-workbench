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

it('transfers a written syncopated line without merging repeated attacks or filling its rests', () => {
  const rhythm = [0, 0.125, 0.5, 1, 4 / 3, 5 / 3, 2.25];
  const durations = [0.125, 0.0625, 0.125, 1 / 3, 1 / 3, 1 / 3, 0.125];
  const pitches = [60, 60, 64, 67, 64, 62, 60];
  const { source, base } = song(rhythm);
  source.source.kind = 'musicxml';
  const keys = source.parts[1];
  keys.notes.forEach((note, i) => {
    const attack = i % rhythm.length;
    note.midi = pitches[attack];
    note.duration = durations[attack];
  });
  const before = structuredClone(source);
  const { project, gestures } = writeInstrumentalLines(source, base);
  const carrier = project.parts.find(part => part.id === gestures[0]?.carrier)!;
  const events = carrier.notes.filter(note => note.start < 4);
  expect(events.map(note => note.start)).toEqual(rhythm);
  expect(events.map(note => note.midi)).toEqual(pitches);
  events.forEach((note, i) => expect(note.duration).toBeCloseTo(durations[i], 8));
  expect(source).toEqual(before);
  expect(project.parts[0]).toEqual(base.parts[0]);
});

it('keeps the previous backing when the optional MIDI line has ambiguous timing', () => {
  const { source, base } = song([0.023, 1.072, 2.09]);
  source.source.kind = 'midi';
  const { project, gestures } = writeInstrumentalLines(source, base);
  expect(gestures).toEqual([]);
  expect(project.parts).toEqual(base.parts);
  expect(project.arrangement?.report.changes.join('')).toContain('未能确认书面起止');
});

it('keeps a locally supported MIDI motif and distinguishes syncopations from tiny drift', () => {
  const rhythm = [0, 0.125, 0.5, 0.75, 4 / 3, 5 / 3, 2.25];
  const { source, base } = song(rhythm.map(beat => beat + 1 / 240));
  source.source.kind = 'midi';
  source.parts[1].notes.forEach((note, i) => {
    if (i % rhythm.length <= 1) {
      note.midi = 60;
      note.duration = 0.089;
    } else note.duration = i % rhythm.length === 3 ? 5 / 12 : 0.203;
  });
  const { project, gestures } = writeInstrumentalLines(source, base);
  const carrier = project.parts.find(part => part.id === gestures[0]?.carrier)!;
  const events = carrier.notes.filter(note => note.start < 4);
  expect(events.map(note => note.start)).toEqual(rhythm);
  expect(events.slice(0, 2).map(note => note.midi)).toEqual([60, 60]);
  expect(events.slice(0, 2).map(note => note.duration)).toEqual([0.0625, 0.0625]);
  expect(events[2].duration).toBeCloseTo(0.125);
  expect(events[3].duration).toBeCloseTo(0.375);
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
