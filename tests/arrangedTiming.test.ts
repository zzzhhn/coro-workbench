import { describe, expect, it } from 'vitest';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { generateArrangementVersion } from '../src/lib/arrangementVersions';
import { createBlankProject } from '../src/lib/demo';
import { projectArrangementNotation } from '../src/lib/midiNotation';
import type { ArrangementOptions, ArrangementPlan, NoteEvent } from '../src/lib/types';

const options: ArrangementOptions = {
  preset: 'solo-satb', style: 'pop', difficulty: 'medium', percussion: false, transpose: 0,
};
const plan: ArrangementPlan = { version: 2, planner: 'manual', ensemble: 'solo+satb', sections: [
  { id: 'chorus', label: 'Chorus', kind: 'chorus', startBar: 1, bars: 2, energy: 3, texture: 'lyric', bass: 'pulse' },
  { id: 'answer', label: 'Answer', kind: 'verse', startBar: 3, bars: 2, energy: 2, texture: 'answer', bass: 'sustain' },
] };

const content = (notes: NoteEvent[]) => notes.map(({ id: _id, ...note }) => note);
const attacks = (notes: NoteEvent[]) => notes.map(({ midi, lyric, dynamic }) => [midi, lyric, dynamic]);
const onGrid = (beat: number) => [16, 12].some(grid => Math.abs(beat * grid - Math.round(beat * grid)) < 1e-6);

function sourceWithLead(withLyrics: boolean) {
  const source = createBlankProject();
  source.source.kind = 'midi';
  source.measures = 4;
  source.chords = [{ start: 0, duration: 16, symbol: 'C', pitches: [48, 52, 55] }];
  source.parts[0].notes = [
    [0, 0.46], [0.5, 0.46], [1, 1 / 3], [4 / 3, 1 / 3], [5 / 3, 1 / 3],
    [2.375, 0.23], [3, 0.44], [3.5, 0.4], [5, 0.46], [6, 0.42],
    [8, 0.46], [10, 0.36], [10.5, 0.25], [11.75, 0.45], [14, 0.46], [15, 0.35],
  ].map(([start, duration], i) => ({
    id: `lead-${i}`, midi: 72, start: start + 1 / 240, duration, velocity: 0.75,
    ...((withLyrics && i < 10) ? { lyric: 'la' } : {}),
  }));
  return source;
}

describe('Generated V2 accompaniment timing', () => {
  it.each([true, false])('uses the same supported attack and release mapping as older scores, lyrics=%s', withLyrics => {
    const source = sourceWithLead(withLyrics);
    const before = structuredClone(source);
    // With measured MIDI projection disabled this is the original V2 output.
    const legacy = arrangeV2({ ...source, source: { ...source.source, kind: 'manual' } }, options, plan);
    const engravedLegacy = projectArrangementNotation({ ...legacy, source: source.source });
    const fresh = arrangeV2(source, options, plan);

    expect(source).toEqual(before);
    expect(content(fresh.parts[0].notes)).toEqual(content(source.parts[0].notes));
    expect(fresh.parts.slice(1).map(part => attacks(part.notes))).toEqual(legacy.parts.slice(1).map(part => attacks(part.notes)));
    expect(fresh.parts.slice(1).map(part => content(part.notes))).toEqual(engravedLegacy.parts.slice(1).map(part => content(part.notes)));
    expect(fresh.parts[1].notes.every(note => onGrid(note.start) && onGrid(note.start + note.duration))).toBe(true);
    expect(fresh.parts[1].notes.some(note => note.start === 2.375)).toBe(true);
    expect(fresh.parts[3].notes.some(note => note.start === 8.5 && note.duration === 1.25)).toBe(true);
    expect(fresh.arrangement?.report.changes.join('')).toContain('MIDI 时钟证据');
    if (withLyrics) {
      expect(fresh.parts[1].notes.slice(0, 2).map(({ start, lyric }) => [start, lyric])).toEqual([[0, 'la'], [0.5, 'la']]);
      expect(fresh.parts[1].notes.find(note => Math.abs(note.start - 4 / 3) < 1e-6)?.duration).toBeCloseTo(1 / 3);
    }
  });

  it('leaves authored timing and MIDI timing without a corroborated clock intact', () => {
    const source = sourceWithLead(true);
    source.parts[0].notes.forEach((note, i) => { note.start += 0.018 * i; });
    const midi = arrangeV2(source, options, plan);
    const manual = arrangeV2({ ...source, source: { ...source.source, kind: 'manual' } }, options, plan);
    expect(midi.parts.map(part => content(part.notes))).toEqual(manual.parts.map(part => content(part.notes)));
    expect(manual.parts[1].notes[0].start).toBe(source.parts[0].notes[0].start);
    expect(midi.arrangement?.report.changes.join('')).not.toContain('MIDI 时钟证据');
  });

  it('regenerates written backing outside locked measures and keeps a complete locked attack', () => {
    const source = sourceWithLead(true);
    source.measures = 26;
    source.chords[0].duration = 104;
    const lead = source.parts[0];
    lead.notes.push(...lead.notes.map(note => ({ ...note, id: `later-${note.id}`, start: note.start + 64 })));
    const old = generateArrangementVersion({ ...source, source: { ...source.source, kind: 'manual' } }, options).project;
    old.source.kind = 'midi';
    const approved = old.parts[1].notes.find(note => note.start >= 64 && note.start < 68)!;
    old.arrangement!.locks = [{ first: 17, last: 17 }];
    const before = structuredClone(old);

    const { project } = generateArrangementVersion(source, options, old);
    expect(project.parts[1].notes.find(note => note.id === approved.id)).toEqual(approved);
    expect(onGrid(approved.start)).toBe(false);
    expect(project.parts[1].notes.filter(note => note.start >= 68).every(note => onGrid(note.start))).toBe(true);
    expect(old).toEqual(before);
  });
});
