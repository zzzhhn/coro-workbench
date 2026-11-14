import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { pitchName, validateProject } from '../src/lib/music';
import { beatAtX, pitchAtStep, placeNote, stepAtY } from '../src/lib/mouseEntry';
import type { NoteEvent } from '../src/lib/types';

const n = (
  id: string,
  start: number,
  duration: number,
  midi: number | null,
  extra: Partial<NoteEvent> = {},
): NoteEvent => ({
  id,
  start,
  duration,
  midi,
  velocity: 0.8,
  ...extra,
});

describe('staff position -> pitch', () => {
  it('reads lines and spaces in each clef', () => {
    expect(pitchName(pitchAtStep('treble', 0, 'C'))).toBe('F5'); // top line
    expect(pitchName(pitchAtStep('treble', 8, 'C'))).toBe('E4'); // bottom line
    expect(pitchName(pitchAtStep('treble', 10, 'C'))).toBe('C4'); // first ledger below
    expect(pitchName(pitchAtStep('treble', -2, 'C'))).toBe('A5'); // first ledger above
    expect(pitchName(pitchAtStep('bass', 0, 'C'))).toBe('A3');
    expect(pitchName(pitchAtStep('bass', 8, 'C'))).toBe('G2');
    expect(pitchName(pitchAtStep('alto', 4, 'C'))).toBe('C4'); // middle line
  });
  it('applies the key signature as on paper', () => {
    expect(pitchName(pitchAtStep('treble', 0, 'D'))).toBe('F#5');
    expect(pitchName(pitchAtStep('treble', 7, 'D'))).toBe('F#4');
    expect(pitchName(pitchAtStep('treble', 4, 'F'))).toBe('A#4'); // B line in F major = Bb
    expect(pitchName(pitchAtStep('treble', 4, 'Em'))).toBe('B4');
  });
  it('y to step rounds to the nearest line or space', () => {
    expect(stepAtY(100, 100, 132)).toBe(0);
    expect(stepAtY(103, 100, 132)).toBe(1);
    expect(stepAtY(98.5, 100, 132)).toBe(0);
    expect(stepAtY(140, 100, 132)).toBe(10);
  });
});

describe('x position -> beat', () => {
  // Barlines at x=100 (beat 0) and x=500 (beat 4), attacks at 140, 240, 300 (beats 0, 1, 1.5).
  const anchors = [
    { x: 100, beat: 0 },
    { x: 140, beat: 0 },
    { x: 240, beat: 1 },
    { x: 300, beat: 1.5 },
    { x: 500, beat: 4 },
  ];
  it('sticks to a nearby attack and interpolates between anchors', () => {
    expect(beatAtX(anchors, 243, 0.25)).toBe(1);
    expect(beatAtX(anchors, 400, 0.25)).toBe(2.75); // halfway between 1.5@300 and 4@500, snapped
    expect(beatAtX(anchors, 260, 0.5)).toBe(1);
  });
  it('never returns a beat at or past the system end, nor before its start', () => {
    expect(beatAtX(anchors, 499, 0.25)).toBe(3.75);
    expect(beatAtX(anchors, 60, 0.25)).toBe(0);
    expect(beatAtX([{ x: 1, beat: 0 }], 10, 1)).toBeUndefined();
  });
});

describe('placing a note', () => {
  const project = () => {
    const p = createBlankProject();
    p.parts[0].notes = [n('q', 0, 1, 60), n('rest', 1, 2, null), n('lyric', 3, 1, 64, { lyric: 'la' })];
    return p;
  };
  it('on a long rest: replaces it and keeps the remainder as a rest', () => {
    const {
      project: out,
      kind,
      selection,
    } = placeNote(project(), { partId: 'piano', staffNumber: 1, beat: 1, midi: 67, duration: 0.5, voice: 1 });
    expect(kind).toBe('replaced-rest');
    expect(out.parts[0].notes.map((note) => [note.start, note.duration, note.midi])).toEqual([
      [0, 1, 60],
      [1, 0.5, 67],
      [1.5, 1.5, null],
      [3, 1, 64],
    ]);
    expect(out.parts[0].notes.find((note) => note.id === selection.noteId)?.origin).toBe('manual');
    expect(validateProject(out)).toEqual([]);
  });
  it('on an existing attack: becomes a chord tone with its length; same pitch just selects', () => {
    const chord = placeNote(project(), {
      partId: 'piano',
      staffNumber: 1,
      beat: 0,
      midi: 64,
      duration: 0.25,
      voice: 1,
    });
    expect(chord.kind).toBe('chord');
    expect(
      chord.project.parts[0].notes
        .filter((note) => note.start === 0)
        .map((note) => [note.midi, note.duration]),
    ).toEqual([
      [60, 1],
      [64, 1],
    ]);
    const same = placeNote(project(), {
      partId: 'piano',
      staffNumber: 1,
      beat: 0,
      midi: 60,
      duration: 1,
      voice: 1,
    });
    expect(same.kind).toBe('existing');
    expect(same.selection.noteId).toBe('q');
  });
  it('in voice 2 on a grand staff: lower staff gets MusicXML voice 6', () => {
    const p = createBlankProject();
    p.parts[0].staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    p.parts[0].notes = [n('lh', 0, 4, 48, { staff: 2, voice: '5' })];
    const out = placeNote(p, {
      partId: 'piano',
      staffNumber: 2,
      beat: 0,
      midi: 43,
      duration: 1,
      voice: 2,
    }).project;
    const added = out.parts[0].notes.find((note) => note.midi === 43)!;
    expect([added.staff, added.voice]).toEqual([2, '6']);
    expect(validateProject(out)).toEqual([]);
  });
  it('a rest tool replaces nothing sounding and extends the score if placed past the end', () => {
    const p = createBlankProject();
    p.measures = 1;
    const out = placeNote(p, {
      partId: 'piano',
      staffNumber: 1,
      beat: 3.5,
      midi: null,
      duration: 1,
      voice: 1,
    }).project;
    expect(out.measures).toBe(2);
    expect(out.parts[0].notes.map((note) => [note.start, note.midi])).toEqual([[3.5, null]]);
  });
});
