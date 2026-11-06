import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { notationReadabilitySummary } from '../src/lib/readability';
import { reinterpretBeatUnit } from '../src/lib/scoreTools';
import { validateProject } from '../src/lib/music';
import type { ScoreProject } from '../src/lib/types';

function fixture(): ScoreProject {
  const project = createBlankProject();
  project.tempo = 65;
  project.measures = 2;
  project.parts[0].notes = [
    { id: 'a', midi: 60, start: 0, duration: 0.125, velocity: 0.8, confidence: 0.5, origin: 'transcribed' },
    { id: 'b', midi: 62, start: 0.25, duration: 0.25, velocity: 0.8, confidence: 0.6, origin: 'transcribed' },
    {
      id: 'c',
      midi: 64,
      start: 0.625,
      duration: 0.375,
      velocity: 0.8,
      confidence: 0.7,
      origin: 'transcribed',
    },
  ];
  project.originalAudio = {
    name: 'fixture.wav',
    url: '/api/audio/test/fixture.wav',
    duration: 9,
    offsetSeconds: -0.4,
    tempo: 65,
  };
  return project;
}

describe('conditional readability advice', () => {
  it('suggests only an actual measured short-glyph decrease and never mutates the input', () => {
    const project = fixture();
    const before = structuredClone(project);
    const summary = notationReadabilitySummary(project, [project.parts[0].id]);
    expect(project).toEqual(before);
    expect(summary).toMatchObject({
      tempo: 65,
      targetTempo: 130,
      smallNotesBefore: 1,
      smallNotesAfter: 0,
      smallRestsBefore: 2,
      smallRestsAfter: 0,
      measuresBefore: 2,
      measuresAfter: 4,
      maximumPolyphonyBefore: 1,
      maximumPolyphonyAfter: 1,
      simultaneousOnsetExtrasBefore: 0,
      simultaneousOnsetExtrasAfter: 0,
      preservesPhysicalSeconds: true,
    });
    expect(summary?.reason).toContain('不是确认原曲速度');
    expect(summary?.reason).toContain('不是确认原曲速度或自动量化');
  });

  it('maintains all note IDs, pitches, counts and physical timing for the suggested operation', () => {
    const source = fixture();
    const summary = notationReadabilitySummary(source)!;
    const target = reinterpretBeatUnit(source, 2).project;
    expect(target.tempo).toBe(summary.targetTempo);
    source.parts[0].notes.forEach((note, index) => {
      const next = target.parts[0].notes[index];
      expect(next.id).toBe(note.id);
      expect(next.midi).toBe(note.midi);
      expect((next.start * 60) / target.tempo).toBeCloseTo((note.start * 60) / source.tempo, 12);
      expect((next.duration * 60) / target.tempo).toBeCloseTo((note.duration * 60) / source.tempo, 12);
      expect(
        (next.start * 60) / target.originalAudio!.tempo! + target.originalAudio!.offsetSeconds,
      ).toBeCloseTo(
        (note.start * 60) / source.originalAudio!.tempo! + source.originalAudio!.offsetSeconds,
        12,
      );
      expect(next.confidence).toBe(note.confidence);
    });
    expect(target.parts[0].notes.length).toBe(source.parts[0].notes.length);
    expect(validateProject(target)).toEqual([]);
  });

  it.each([90, 100, 129.996])('does not offer automatic reinterpretation at %s BPM', (tempo) => {
    const project = fixture();
    project.tempo = tempo;
    expect(notationReadabilitySummary(project)).toBeUndefined();
  });

  it('does not recommend doubling merely because a song is slow', () => {
    const project = fixture();
    project.parts[0].notes = [{ id: 'whole', midi: 60, start: 0, duration: 8, velocity: 0.8 }];
    expect(notationReadabilitySummary(project)).toBeUndefined();
  });

  it('uses selected parts only and ignores nonexistent or empty selections', () => {
    const project = fixture();
    project.parts.push({
      ...structuredClone(project.parts[0]),
      id: 'long',
      notes: [{ id: 'long-note', midi: 48, start: 0, duration: 8, velocity: 0.8 }],
    });
    expect(notationReadabilitySummary(project, ['long'])).toBeUndefined();
    expect(notationReadabilitySummary(project, [])).toBeUndefined();
    expect(notationReadabilitySummary(project, ['missing'])).toBeUndefined();
    expect(notationReadabilitySummary(project, [project.parts[0].id])?.partIds).toEqual([
      project.parts[0].id,
    ]);
  });

  it('counts collisions without declaring a polyphonic part monophonic', () => {
    const project = fixture();
    project.parts[0].notes.push({ id: 'duplicate', midi: 67, start: 0, duration: 0.125, velocity: 0.8 });
    const summary = notationReadabilitySummary(project)!;
    expect(summary.maximumPolyphonyBefore).toBe(2);
    expect(summary.maximumPolyphonyAfter).toBe(2);
    expect(summary.simultaneousOnsetExtrasBefore).toBe(1);
    expect(summary.simultaneousOnsetExtrasAfter).toBe(1);
    expect(summary.smallNotesBefore).toBe(1);
  });

  it('declines unsupported target sizes or source-audio tempos without breaking the UI', () => {
    const project = fixture();
    project.measures = 1025;
    expect(notationReadabilitySummary(project)).toBeUndefined();
    project.measures = 2;
    project.originalAudio!.tempo = 300;
    expect(notationReadabilitySummary(project)).toBeUndefined();
    project.originalAudio!.tempo = 65;
    project.parts[0].notes[0].duration = -1;
    expect(notationReadabilitySummary(project)).toBeUndefined();
  });
});
