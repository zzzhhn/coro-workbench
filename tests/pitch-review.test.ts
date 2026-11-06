import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toMusicXml } from '../src/lib/music';
import { deleteNote } from '../src/lib/editor';
import {
  changedReviewNotes,
  coverageWindowStart,
  editNoteFromSourceTime,
  insertNoteFromSourceTime,
  pitchEvidenceJobId,
  pitchBranchUrl,
  sourceBeat,
  sourceSecond,
  sourceWindowNotes,
  splitNoteAtSourceTime,
} from '../src/lib/pitchReview';

function fixture() {
  const project = createBlankProject();
  project.tempo = 65;
  project.parts[0].id = 'vocals';
  project.parts[0].notes = [
    { id: 'held', midi: 60, start: 4, duration: 2, velocity: 0.8, confidence: 0.7, lyric: 'la' },
  ];
  project.originalAudio = {
    name: 'original.wav',
    url: '/api/audio/a/original.wav',
    duration: 30,
    offsetSeconds: -2,
    tempo: 130,
  };
  return project;
}

describe('source-time correction contracts', () => {
  it('navigates listening priorities in original seconds with bounded one-second context', () => {
    const interval = {
      kind: 'fcpe_missing' as const,
      startSeconds: 131.2,
      endSeconds: 132,
      supportSeconds: 0.8,
      supportFraction: 1,
    };
    expect(coverageWindowStart(interval, 8, 178)).toBeCloseTo(130.2);
    expect(coverageWindowStart({ ...interval, startSeconds: 0.1 }, 8, 178)).toBe(0);
    expect(coverageWindowStart({ ...interval, startSeconds: 177 }, 8, 178)).toBe(170);
    expect(coverageWindowStart(interval, 8, 3)).toBe(0);
  });
  it('uses original tempo and offset rather than slowed rehearsal speed', () => {
    const project = fixture();
    expect(sourceSecond(project, 13)).toBe(4);
    expect(sourceBeat(project, 4)).toBe(13);
    expect(sourceWindowNotes(project, 'vocals', 0, 1)).toHaveLength(1);
    expect(sourceWindowNotes(project, 'vocals', 2, 3)).toHaveLength(0);
  });
  it('edits only the chosen original note, retains identity and clears stale confidence', () => {
    const project = fixture();
    const before = structuredClone(project);
    const next = editNoteFromSourceTime(project, 'vocals', 'held', 72, 0, 1);
    expect(project).toEqual(before);
    expect(next.parts[0].notes[0]).toMatchObject({ id: 'held', midi: 72, lyric: 'la', origin: 'manual' });
    expect(next.parts[0].notes[0].confidence).toBeUndefined();
    expect(sourceSecond(next, next.parts[0].notes[0].start)).toBeCloseTo(0, 3);
    expect(changedReviewNotes(project, next, 'vocals')).toBe(1);
    expect(next.originalAudio).toEqual(project.originalAudio);
  });
  it('splits inside a note without adding duplicate lyrics or moving other notes', () => {
    const project = fixture();
    const at = sourceSecond(project, 5);
    const next = splitNoteAtSourceTime(project, 'vocals', 'held', at);
    expect(next.parts[0].notes).toHaveLength(2);
    expect(next.parts[0].notes.map((n) => [n.start, n.duration, n.midi])).toEqual([
      [4, 1, 60],
      [5, 1, 60],
    ]);
    expect(next.parts[0].notes[1].lyric).toBeUndefined();
    expect(next.parts[0].notes[0].id).toBe('held');
    expect(changedReviewNotes(project, next, 'vocals')).toBe(2);
    expect(project.parts[0].notes).toHaveLength(1);
  });
  it('rejects impossible pitch/time edits instead of silently clamping', () => {
    expect(() => editNoteFromSourceTime(fixture(), 'vocals', 'held', 200, 0, 1)).toThrow();
    expect(() => editNoteFromSourceTime(fixture(), 'vocals', 'held', 60, 1, 0)).toThrow();
    expect(() => editNoteFromSourceTime(fixture(), 'vocals', 'held', 60, -3, 0)).toThrow();
    expect(() => splitNoteAtSourceTime(fixture(), 'vocals', 'held', 30)).toThrow();
  });
  it('can add a missed note and remove a false event without changing source evidence', () => {
    const project = fixture(),
      before = structuredClone(project);
    const result = insertNoteFromSourceTime(project, 'vocals', 62, 2, 2.5);
    expect(result.project.parts[0].notes).toHaveLength(2);
    expect(result.project.originalAudio).toEqual(project.originalAudio);
    expect(result.project.source).toEqual(project.source);
    expect(changedReviewNotes(project, result.project, 'vocals')).toBe(1);
    const reverted = deleteNote(result.project, result.selection);
    expect(reverted.parts).toEqual(project.parts);
    expect(project).toEqual(before);
    expect(() => insertNoteFromSourceTime(project, 'vocals', 62, 2, 1)).toThrow();
  });
  it('stores an arbitrary-second split on the same tick resolution as MusicXML', () => {
    const project = fixture();
    const next = splitNoteAtSourceTime(project, 'vocals', 'held', 0.333);
    const notes = next.parts[0].notes;
    expect(notes[1].start * 960).toBeCloseTo(Math.round(notes[1].start * 960), 9);
    expect(notes[0].duration + notes[1].duration).toBeCloseTo(2, 12);
    const restored = fromMusicXml(toMusicXml(next));
    const restoredNotes = restored.parts[0].notes.filter((note) => note.midi !== null);
    expect(restoredNotes).toHaveLength(notes.length);
    restoredNotes.forEach((note, index) => {
      expect(note.midi).toBe(notes[index].midi);
      expect(note.start).toBeCloseTo(notes[index].start, 10);
      expect(note.duration).toBeCloseTo(notes[index].duration, 10);
    });
  });
  it('requires a real retained evidence link and does not infer one from bundle ids', () => {
    const project = fixture();
    expect(pitchEvidenceJobId(project)).toBeUndefined();
    project.source.analysis = { transforms: [], rawProjectUrl: `/api/projects/${'a'.repeat(32)}/raw` };
    expect(pitchEvidenceJobId(project)).toBe('a'.repeat(32));
    project.source.analysis.rawProjectUrl = 'https://untrusted.invalid/private';
    expect(pitchEvidenceJobId(project)).toBeUndefined();
  });
  it('does not load a remote model-branch URL from an imported project', () => {
    expect(pitchBranchUrl('https://untrusted.invalid/track.wav')).toBeUndefined();
    expect(pitchBranchUrl('//untrusted.invalid/track.wav')).toBeUndefined();
    expect(pitchBranchUrl(`/api/audio/${'a'.repeat(32)}/stem-lead.wav`)).toBeDefined();
    expect(pitchBranchUrl('local:bundle-1234-abcd')).toBeDefined();
    expect(pitchBranchUrl(`/api/audio/${'a'.repeat(32)}/../../config.json`)).toBeUndefined();
  });
});
