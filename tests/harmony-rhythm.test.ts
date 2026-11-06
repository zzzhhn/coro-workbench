import { describe, expect, it } from 'vitest';
import { harmonyNoteDuration, planHarmonySlots } from '../src/lib/harmonyRhythm';
import { arrangeForVoices } from '../src/lib/arrange';
import { createDemoProject } from '../src/lib/demo';
import type { ArrangementOptions, ChordEvent } from '../src/lib/types';

const options: ArrangementOptions = { preset: 'satb', style: 'pop', difficulty: 'medium', percussion: false, transpose: 0 };
const chord = (start: number, duration: number): ChordEvent => ({ start, duration, symbol: 'C', pitches: [48, 52, 55] });

describe('vocal accompaniment rhythm', () => {
  it('does not subtract a half beat then force a 32nd from a short slot', () => {
    expect(harmonyNoteDuration(.5, 105, options)).toBe(.5);
    expect(harmonyNoteDuration(.25, 105, options)).toBe(.25);
    expect(harmonyNoteDuration(2, 105, options)).toBe(1.5);
  });
  it('preserves true chord changes but removes a nearby mechanical pulse', () => {
    const chords = [chord(8, 5.5), chord(13.5, 4.5)];
    const before = structuredClone(chords);
    const result = planHarmonySlots(chords, 20, 4, 105, options);
    expect(result.boundaries).toContain(13.5);
    expect(result.boundaries).not.toContain(14);
    expect(result.skippedPulseCuts).toBeGreaterThan(0);
    expect(chords).toEqual(before);
  });
  it('keeps the 2-beat pulse on ordinary full-bar chords', () => {
    expect(planHarmonySlots([chord(0, 4), chord(4, 4)], 8, 4, 100, options).boundaries).toEqual([0, 2, 4, 6, 8]);
  });
  it('does not make another brief fragment at every fourth-bar phrase end', () => {
    const project = createDemoProject();
    project.chords = [chord(15.5, 2.5)];
    const result = arrangeForVoices(project, { ...options, style: 'choral' });
    for (const part of result.parts.slice(1)) {
      const notes = part.notes.filter((note) => note.midi !== null);
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0].start).toBe(15.5);
      expect(notes[0].duration).toBeGreaterThanOrEqual(.5);
    }
  });
  it('uses physical sound duration for releases at fast tempo', () => {
    expect(harmonyNoteDuration(1, 240, options)).toBe(1);
    expect(harmonyNoteDuration(1, 100, options)).toBe(.5);
  });
  it('retains both ends of genuine short chords and no-chord gaps', () => {
    const boundaries = planHarmonySlots([chord(1, .25), chord(3, 2)], 8, 4, 120, options).boundaries;
    expect(boundaries).toEqual(expect.arrayContaining([1, 1.25, 3, 5]));
  });
  it('rejects invalid timing rather than looping on a nonpositive meter', () => {
    expect(() => planHarmonySlots([], 8, 0, 120, options)).toThrow();
    expect(() => harmonyNoteDuration(-1, 120, options)).toThrow();
  });
});
