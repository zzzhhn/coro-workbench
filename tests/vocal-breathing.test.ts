import { describe, expect, it } from 'vitest';
import { planVocalBreaths, vocalPhrases } from '../src/lib/vocalBreathing';
import type { NoteEvent } from '../src/lib/types';

const note = (id: string, start: number, duration: number, midi = 60): NoteEvent => ({
  id,
  start,
  duration,
  midi,
  velocity: 0.8,
  lyric: 'word',
  confidence: 0.9,
});
const plan = (notes: NoteEvent[], tempo = 120, limit = 10) => {
  let count = 0;
  return planVocalBreaths(notes, tempo, 4, limit, () => `breath-${++count}`);
};

describe('physical vocal breathing', () => {
  it('counts rests in seconds, not a fixed number of beats', () => {
    const notes = [note('a', 0, 2), note('b', 2.5, 2)];
    expect(vocalPhrases(notes, 60)).toHaveLength(2);
    expect(vocalPhrases(notes, 200)).toHaveLength(1);
  });
  it('does not cut existing comfortably separated phrases', () => {
    const notes = [note('a', 0, 4), note('b', 5, 4), note('c', 10, 4)];
    const result = plan(notes);
    expect(result.cuts).toHaveLength(0);
    expect(result.notes).toEqual(notes);
  });
  it('creates real gaps before a new attack without removing notes or moving their onsets', () => {
    const notes = Array.from({ length: 20 }, (_, index) => note(String(index), index * 2, 2));
    const before = structuredClone(notes);
    const result = plan(notes, 65);
    expect(result.cuts.length).toBeGreaterThan(0);
    expect(result.longestPhraseSeconds).toBeLessThanOrEqual(10.000001);
    expect(result.notes.map((item) => [item.id, item.start, item.midi, item.lyric])).toEqual(
      notes.map((item) => [item.id, item.start, item.midi, item.lyric]),
    );
    expect(notes).toEqual(before);
    for (const cut of result.cuts) {
      expect(((cut.resumeBeat - cut.startBeat) * 60) / 65).toBeGreaterThanOrEqual(0.3);
      expect(
        result.notes.some(
          (item) => item.start < cut.resumeBeat - 1e-7 && item.start + item.duration > cut.startBeat + 1e-7,
        ),
      ).toBe(false);
    }
  });
  it('splits very long held vowels but does not repeat words or overwrite source duration', () => {
    const original = [note('held', 0, 80)];
    const result = plan(original, 120);
    expect(result.cuts.every((cut) => cut.split)).toBe(true);
    expect(result.cuts.length).toBeGreaterThan(1);
    expect(result.longestPhraseSeconds).toBeLessThanOrEqual(10.000001);
    expect(result.notes.at(-1)!.start + result.notes.at(-1)!.duration).toBe(80);
    expect(result.notes[0].lyric).toBe('word');
    expect(result.notes.slice(1).every((item) => item.lyric === undefined)).toBe(true);
    expect(result.notes.every((item) => item.duration >= 0.125 && item.confidence === undefined)).toBe(true);
    expect(original[0].duration).toBe(80);
  });
  it('does not pretend half a beat at high tempo is enough air', () => {
    const result = plan(
      Array.from({ length: 80 }, (_, i) => note(String(i), i * 2, 1.5)),
      240,
    );
    expect((result.gapBeats * 60) / 240).toBeGreaterThanOrEqual(0.3);
    expect(result.cuts.length).toBeGreaterThan(0);
    expect(result.longestPhraseSeconds).toBeLessThanOrEqual(10.000001);
  });
  it('reports fast passages with no safe tail instead of deleting melody attacks', () => {
    const notes = Array.from({ length: 120 }, (_, i) => note(String(i), i / 4, 0.25));
    const result = plan(notes);
    expect(result.cuts).toHaveLength(0);
    expect(result.unresolvedPhrases).toHaveLength(1);
    expect(result.notes).toEqual(notes);
  });
  it('handles unsorted input and ignores explicitly silent notes', () => {
    const notes = [note('later', 5, 2), { ...note('silent', 0, 40), velocity: 0 }, note('first', 0, 2)];
    expect(plan(notes).cuts).toHaveLength(0);
    expect(vocalPhrases(notes, 120).map((item) => [item.start, item.end])).toEqual([
      [0, 2],
      [5, 7],
    ]);
  });
  it('does not turn accompaniment tails into tiny notes just to insert a breath', () => {
    const notes = [
      ...Array.from({ length: 9 }, (_, i) => note(String(i), i * 2, 1.5)),
      note('short', 18, .5),
      ...Array.from({ length: 6 }, (_, i) => note(`tail-${i}`, 19 + i * 2, 1.5)),
    ];
    let id = 0;
    const result = planVocalBreaths(notes, 110, 4, 10, () => `breath-${++id}`, .2);
    expect(result.cuts.length).toBeGreaterThan(0);
    expect(result.notes.every((n) => n.duration * 60 / 110 >= .2 - 1e-7)).toBe(true);
    expect(result.notes.map((n) => n.start)).toEqual(notes.map((n) => n.start));
  });
  it('moves a backing split earlier when a sustain ends just beyond the phrase deadline', () => {
    const notes = [
      note('a', 0, 3.75), note('b', 3.75, 1.75), note('c', 5.5, 4.5),
      note('d', 10, 2), note('e', 12, 4.25), note('f', 16.25, 3.75),
    ];
    const before = structuredClone(notes);
    const result = planVocalBreaths(notes, 93.0202, 4, 10, () => 'resumed', .2);
    expect(result.unresolvedPhrases).toHaveLength(0);
    expect(result.longestPhraseSeconds).toBeLessThanOrEqual(10);
    expect(result.cuts).toEqual([{ startBeat: 15.375, resumeBeat: 15.875, sourceNoteId: 'e', split: true }]);
    expect(result.notes.every((n) => n.duration * 60 / 93.0202 >= .2)).toBe(true);
    expect(result.notes.filter((n) => n.id !== 'resumed').map((n) => [n.id, n.start, n.midi]))
      .toEqual(notes.map((n) => [n.id, n.start, n.midi]));
    for (const cut of result.cuts)
      expect(result.notes.some((n) => n.start < cut.resumeBeat && n.start + n.duration > cut.startBeat)).toBe(false);
    expect(notes).toEqual(before);
  });
});
