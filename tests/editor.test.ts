import { describe, expect, it } from 'vitest';
import { createBlankProject, createDemoProject } from '../src/lib/demo';
import {
  changePart,
  deleteNote,
  duplicateMeasure,
  insertNote,
  modifyNote,
  transposeProject,
} from '../src/lib/editor';
import { toAbc, toMusicXml, validateProject } from '../src/lib/music';

describe('editor preserves musical intent', () => {
  it('does not relabel a manually corrected pitch with the old model score', () => {
    const source = createBlankProject();
    source.parts[0].notes = [
      {
        id: 'machine',
        midi: 60,
        start: 0,
        duration: 1,
        velocity: 0.8,
        confidence: 0.4,
        origin: 'transcribed',
      },
    ];
    const selection = { partId: source.parts[0].id, noteId: 'machine' };
    expect(modifyNote(source, selection, { midi: 62 }).parts[0].notes[0].confidence).toBeUndefined();
    expect(modifyNote(source, selection, { lyric: 'la' }).parts[0].notes[0].confidence).toBe(0.4);
    expect(source.parts[0].notes[0].confidence).toBe(0.4);
  });
  it('does not quantize triplets on a lyric or pitch edit', () => {
    const original = createBlankProject();
    original.parts[0].notes = [{ id: 'triplet', start: 1 / 3, duration: 1 / 3, midi: 60, velocity: 0.8 }];
    const selection = { partId: original.parts[0].id, noteId: 'triplet' };
    for (const patch of [{ lyric: 'doo' }, { midi: 61 }, { dynamic: 'mf' as const }]) {
      const edited = modifyNote(original, selection, patch);
      expect(edited.parts[0].notes[0].start).toBe(1 / 3);
      expect(edited.parts[0].notes[0].duration).toBe(1 / 3);
    }
    expect(original.parts[0].notes[0].lyric).toBeUndefined();
  });

  it('supports explicit tuplet durations at the score resolution', () => {
    const original = createBlankProject();
    const inserted = insertNote(original, original.parts[0].id, 0, 1, 60);
    const edited = modifyNote(inserted.project, inserted.selection, { duration: 1 / 3, start: 2 / 3 });
    expect(edited.parts[0].notes[0].duration).toBe(1 / 3);
    expect(edited.parts[0].notes[0].start).toBe(2 / 3);
    expect(validateProject(edited)).toEqual([]);
  });

  it('extends measures when inserting and rejects oversized input', () => {
    const original = createBlankProject();
    const result = insertNote(original, original.parts[0].id, 33, 4, null);
    expect(result.project.measures).toBe(10);
    expect(original.parts[0].notes).toEqual([]);
    expect(() => insertNote(original, original.parts[0].id, 99999999, 1, 60)).toThrow('2048');
  });

  it('copies held notes and harmonic overlaps, shifts continuation exactly', () => {
    const original = createBlankProject();
    original.measures = 3;
    original.parts[0].notes = [{ id: 'held', start: 0, duration: 10, midi: 60, velocity: 0.8 }];
    original.chords = [{ start: 0, duration: 12, symbol: 'C', pitches: [48, 52, 55] }];
    const next = duplicateMeasure(original, 2);
    expect(next.measures).toBe(4);
    expect(next.parts[0].notes.map((note) => [note.start, note.duration])).toEqual([
      [0, 8],
      [8, 4],
      [12, 2],
    ]);
    expect(next.chords.map((chord) => [chord.start, chord.duration])).toEqual([
      [0, 8],
      [8, 4],
      [12, 4],
    ]);
    expect(original.parts[0].notes[0].duration).toBe(10);
    expect(new Set(next.parts[0].notes.map((note) => note.id)).size).toBe(3);
    expect(validateProject(next)).toEqual([]);
    expect(() => toAbc(next)).not.toThrow();
  });

  it('copies and clips crossing note from duplicated measure without overlaps', () => {
    const original = createBlankProject();
    original.measures = 3;
    original.parts[0].notes = [
      { id: 'held', start: 7, duration: 3, midi: 65, velocity: 0.6, lyric: 'la' },
      { id: 'later', start: 10, duration: 1, midi: 67, velocity: 0.6 },
    ];
    const next = duplicateMeasure(original, 2);
    expect(next.parts[0].notes.map((note) => [note.start, note.duration])).toEqual([
      [7, 1],
      [11, 1],
      [12, 2],
      [14, 1],
    ]);
    expect(validateProject(next)).toEqual([]);
  });

  it('transposes pitch/key/chords but never percussion or singer ranges', () => {
    const original = createDemoProject();
    original.parts[0].range = [60, 81];
    const shifted = transposeProject(original, 1);
    expect(shifted.key).toBe('Gb');
    expect(shifted.parts[0].notes[0].midi).toBe(original.parts[0].notes[0].midi! + 1);
    expect(shifted.parts.at(-1)!.notes).toEqual(original.parts.at(-1)!.notes);
    expect(shifted.parts[0].range).toEqual([60, 81]);
    expect(shifted.chords[0].pitches).toEqual(original.chords[0].pitches.map((pitch) => pitch + 1));
    expect(validateProject(shifted)).toEqual([]);
  });

  it('rejects out-of-range transposition without collapsing pitches', () => {
    const original = createBlankProject();
    original.parts[0].notes = [{ id: 'top', midi: 127, start: 0, duration: 1, velocity: 1 }];
    expect(() => transposeProject(original, 1)).toThrow('范围');
    expect(original.parts[0].notes[0].midi).toBe(127);
    original.parts[0].notes = [];
    original.chords = [{ start: 0, duration: 4, symbol: 'C', pitches: [127] }];
    expect(() => transposeProject(original, 1)).toThrow('范围');
  });

  it('edits and deletes only the selected part with duplicate local note IDs', () => {
    const original = createBlankProject();
    original.parts[0].notes = [{ id: 'n1', midi: 60, start: 0, duration: 1, velocity: 1 }];
    original.parts.push({
      ...original.parts[0],
      id: 'other',
      notes: [{ ...original.parts[0].notes[0], midi: 64 }],
    });
    const edited = modifyNote(original, { partId: 'other', noteId: 'n1' }, { midi: 65 });
    expect(edited.parts[0].notes[0].midi).toBe(60);
    expect(edited.parts[1].notes[0].midi).toBe(65);
    const deleted = deleteNote(edited, { partId: 'other', noteId: 'n1' });
    expect(deleted.parts[0].notes).toHaveLength(1);
    expect(deleted.parts[1].notes).toHaveLength(0);
  });

  it('mixer edits keep musical events and exports unchanged', () => {
    const original = createDemoProject();
    const edited = changePart(original, original.parts[0].id, { muted: true, solo: true, volume: 0.3 });
    expect(edited.parts[0].notes).toEqual(original.parts[0].notes);
    expect(toAbc(edited).abc).toEqual(toAbc(original).abc);
    expect(toMusicXml(edited)).toContain('<volume>30</volume>');
  });
});
