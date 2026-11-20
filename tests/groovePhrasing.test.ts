import { expect, it } from 'vitest';
import { createDemoProject } from '../src/lib/demo';
import { generateArrangementVersion } from '../src/lib/arrangementVersions';
import { beatsPerBar } from '../src/lib/music';
import type { ArrangementOptions, ChordEvent, NoteEvent } from '../src/lib/types';

it.each([[3, 4], [6, 8]] as const)('follows the singer and the source bass in %i/%i', (top, bottom) => {
  const source = createDemoProject();
  source.timeSignature = [top, bottom];
  source.measures = 8;
  delete source.source.arrangementSections;
  const bar = beatsPerBar(source);
  const note = (start: number, midi: number, duration: number): NoteEvent =>
    ({ id: String(start), midi, start, duration, velocity: .7, origin: 'manual' });
  const sourceLead = source.parts[0], sourceBass = source.parts[1];
  source.parts = [sourceLead, sourceBass];
  sourceLead.notes = [];
  sourceBass.notes = [];
  sourceBass.role = 'bass';
  for (let i = 0; i < source.measures; i++) {
    sourceLead.notes.push(note(i * bar, i < 4 ? 62 : 74, 1), note(i * bar + 1, i < 4 ? 62 : 74, 1.5));
    sourceBass.notes.push(note(i * bar, 38, 1), note(i * bar + 1.5, 50, .5), note(i * bar + 2, 45, 1));
  }
  const chord: ChordEvent = { ...source.chords[0], symbol: 'D', pitches: [50, 54, 57], start: 0, duration: 8 * bar };
  source.chords = [chord];
  const options: ArrangementOptions = { preset: 'solo-satb', engine: 'groove', style: 'pop', difficulty: 'medium',
    transpose: 0, leadPartId: sourceLead.id, bassPartId: sourceBass.id, percussion: false };
  const base = generateArrangementVersion(source, options).project;
  const responsive = { ...options, groovePhrasing: 'responsive' as const };
  const result = generateArrangementVersion(source, responsive, base).project;
  expect(result.parts[0].notes).toEqual(base.parts[0].notes);
  expect(result.chords).toEqual(base.chords);
  expect(generateArrangementVersion(source, responsive, result).identical).toBe(true);
  const bass = result.parts.at(-1)!.notes;
  const soprano = result.parts[1].notes;
  for (const patch of [0, 4 * bar]) expect(soprano.some(n => n.start >= patch && n.start < patch + 4 * bar)).toBe(true);
  expect(bass.filter(n => n.start < 4*bar).length).toBeLessThan(bass.filter(n => n.start >= 4*bar).length);
  for (let i = 0; i < 8; i++) expect(bass.some(n => n.start === i*bar && n.midi! % 12 === 2)).toBe(true);
  expect(generateArrangementVersion(source, options, base).identical).toBe(true);
});
