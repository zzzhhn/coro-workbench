import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import {
  appendNote,
  applyAccidental,
  commitLyric,
  crossPartNote,
  diatonicStep,
  letterPitch,
  neighbourNote,
  nextIssue,
  reviewIssues,
  setNoteDuration,
  setNotePitch,
  toggleDot,
  toggleTriplet,
} from '../src/lib/noteInput';
import { fromMusicXml, toMusicXml, validateProject } from '../src/lib/music';
import type { NoteEvent } from '../src/lib/types';

const note = (
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

function project(notes: NoteEvent[], key = 'C') {
  const value = createBlankProject();
  value.key = key;
  value.parts[0].notes = notes;
  return value;
}
const sel = (p: ReturnType<typeof project>, noteId: string) => ({ partId: p.parts[0].id, noteId });

describe('pitch entry follows the printed key', () => {
  it('types letter names inside the key signature in the nearest octave', () => {
    expect(letterPitch('F', 'G', 64)).toBe(66); // F# in G major
    expect(letterPitch('B', 'F', 67)).toBe(70); // Bb in F major
    expect(letterPitch('C', 'C', 71)).toBe(72); // B4 -> C5, not C4
    expect(letterPitch('a', 'C', 50)).toBe(45); // nearest A below D3
    expect(letterPitch('E', 'C#', 64)).toBe(65); // E# in C# major
    expect(letterPitch('C', 'Cb', 60)).toBe(59); // Cb in Cb major
  });
  it('moves one staff step diatonically: E-F and B-C are semitones', () => {
    expect(diatonicStep(64, 'C', 1)).toBe(65);
    expect(diatonicStep(60, 'C', -1)).toBe(59);
    expect(diatonicStep(64, 'G', 1)).toBe(66);
    expect(diatonicStep(70, 'F', -1)).toBe(69);
  });
  it('re-applies accidentals to the written letter instead of adding semitones', () => {
    expect(applyAccidental(67, 'C', 'sharp')).toBe(68);
    expect(applyAccidental(68, 'C', 'natural')).toBe(67); // G# -> G
    expect(applyAccidental(68, 'C', 'flat')).toBe(66); // G# -> Gb
    expect(applyAccidental(70, 'F', 'natural')).toBe(71); // Bb -> B
    // Repeating the same accidental is idempotent, unlike a semitone nudge.
    expect(applyAccidental(applyAccidental(67, 'C', 'sharp'), 'C', 'sharp')).toBe(68);
  });
});

describe('duration edits keep neighbours in place', () => {
  const base = () => project([note('a', 0, 2, 60), note('b', 2, 1, 62), note('c', 3, 1, 64)]);
  it('shortening leaves a gap and never shifts later notes', () => {
    const p = base();
    const { project: edited, overlaps } = setNoteDuration(p, sel(p, 'a'), 1);
    expect(overlaps).toBe(0);
    expect(edited.parts[0].notes.map((n) => [n.id, n.start, n.duration])).toEqual([
      ['a', 0, 1],
      ['b', 2, 1],
      ['c', 3, 1],
    ]);
    expect(p.parts[0].notes[0].duration).toBe(2);
  });
  it('lengthening over a neighbour is reported and listed for review', () => {
    const p = base();
    const { project: edited, overlaps } = setNoteDuration(p, sel(p, 'a'), 4);
    expect(overlaps).toBe(2);
    expect(
      reviewIssues(edited)
        .filter((i) => i.kind === 'overlap')
        .map((i) => i.noteId),
    ).toEqual(['b', 'c']);
  });
  it('dot and triplet toggle round-trip and survive MusicXML export', () => {
    const p = base();
    const dotted = toggleDot(p, sel(p, 'b')).project;
    expect(dotted.parts[0].notes.find((n) => n.id === 'b')!.duration).toBe(1.5);
    expect(toggleDot(dotted, sel(p, 'b')).project.parts[0].notes.find((n) => n.id === 'b')!.duration).toBe(1);
    const triplet = project([note('t1', 0, 0.5, 60), note('t2', 0.5, 0.5, 62), note('t3', 1, 0.5, 64)]);
    let q = triplet;
    for (const id of ['t1', 't2', 't3']) q = toggleTriplet(q, sel(q, id)).project;
    // Toggle changes length only; onsets are corrected by the user next.
    expect(q.parts[0].notes.map((n) => n.duration)).toEqual(
      [1 / 3, 1 / 3, 1 / 3].map((d) => Math.round(d * 960) / 960),
    );
    expect(validateProject(q)).toEqual([]);
  });
  it('does not fight with other staff/voice lanes on a grand staff', () => {
    const p = project([
      note('rh', 0, 1, 72, { staff: 1, voice: '1' }),
      note('lh', 0.5, 1, 48, { staff: 2, voice: '5' }),
    ]);
    p.parts[0].staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    expect(setNoteDuration(p, sel(p, 'rh'), 2).overlaps).toBe(0);
  });
});

describe('selection model', () => {
  it('arrows walk attacks in the same lane, not chord tones or the other hand', () => {
    const p = project([
      note('c1', 0, 1, 64, { staff: 1, voice: '1' }),
      note('c1low', 0, 1, 60, { staff: 1, voice: '1' }),
      note('lh', 0.5, 1, 48, { staff: 2, voice: '5' }),
      note('c2', 1, 1, 65, { staff: 1, voice: '1' }),
    ]);
    p.parts[0].staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    expect(neighbourNote(p, sel(p, 'c1'), 1)?.noteId).toBe('c2');
    expect(neighbourNote(p, sel(p, 'c2'), -1)?.noteId).toBe('c1');
    expect(neighbourNote(p, sel(p, 'c2'), 1)).toBeUndefined();
  });
  it('moves vertically to the note sounding at the same beat in the adjacent part', () => {
    const p = project([note('s', 1, 1, 72)]);
    p.parts.push({
      ...structuredClone(p.parts[0]),
      id: 'alto',
      notes: [note('a0', 0, 2, 64), note('a2', 2, 1, 65)],
    });
    expect(crossPartNote(p, sel(p, 's'), 1)).toEqual({ partId: 'alto', noteId: 'a0' });
    expect(crossPartNote(p, { partId: 'alto', noteId: 'a2' }, -1)).toEqual({
      partId: p.parts[0].id,
      noteId: 's',
    });
    expect(crossPartNote(p, sel(p, 's'), -1)).toBeUndefined();
  });
  it('a shared anchor beat makes down-then-up a round trip across a held note', () => {
    // Soprano attacks on beat 2 while the alto holds from beat 1 (seen on a real OMR import).
    const p = project([note('s1', 0, 1, 72), note('s2', 1, 1, 74)]);
    p.parts.push({ ...structuredClone(p.parts[0]), id: 'alto', notes: [note('hold', 0, 2, 65)] });
    const down = crossPartNote(p, sel(p, 's2'), 1, undefined, 1)!;
    expect(down.noteId).toBe('hold');
    expect(crossPartNote(p, down, -1)?.noteId).toBe('s1'); // without anchor: hold's onset
    expect(crossPartNote(p, down, -1, undefined, 1)?.noteId).toBe('s2'); // with anchor: back home
  });
  it('step entry appends in the caret lane and the toggle to rest keeps rhythm', () => {
    const p = project([note('a', 0, 1, 60, { staff: 2, voice: '5' })]);
    p.parts[0].staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    const appended = appendNote(p, p.parts[0].id, 1, 0.5, 62, { staff: 2, voice: '5' });
    const added = appended.project.parts[0].notes.find((n) => n.id === appended.selection.noteId)!;
    expect([added.start, added.duration, added.staff, added.voice]).toEqual([1, 0.5, 2, '5']);
    const rest = setNotePitch(p, sel(p, 'a'), null).parts[0].notes[0];
    expect([rest.midi, rest.start, rest.duration, rest.staff]).toEqual([null, 0, 1, 2]);
  });
});

describe('lyric flow', () => {
  it('space advances to the next sung note, skipping rests and chord tones', () => {
    const p = project([
      note('n1', 0, 1, 64),
      note('n1low', 0, 1, 60),
      note('rest', 1, 1, null),
      note('n2', 2, 1, 65),
    ]);
    const first = commitLyric(p, sel(p, 'n1'), ' 啦 ');
    expect(first.project.parts[0].notes.find((n) => n.id === 'n1')!.lyric).toBe('啦');
    expect(first.next?.noteId).toBe('n2');
    const hyphen = commitLyric(first.project, first.next!, 'hal-');
    expect(hyphen.project.parts[0].notes.find((n) => n.id === 'n2')!.lyric).toBe('hal-');
    expect(hyphen.next).toBeUndefined();
    const back = commitLyric(first.project, sel(p, 'n2'), '', -1);
    expect(back.next?.noteId).toBe('n1');
    expect(back.project).toBe(first.project); // empty and unchanged: no history entry
  });
  it('a hyphenated syllable survives MusicXML round-trip as text', () => {
    const p = commitLyric(project([note('n1', 0, 1, 64)]), { partId: 'piano', noteId: 'n1' }, 'la-').project;
    const back = fromMusicXml(toMusicXml(p));
    expect(back.parts[0].notes[0].lyric).toBe('la-');
  });
});

describe('proof-reading queue', () => {
  it('orders overlaps and low-confidence notes by score time and cycles', () => {
    const p = project([
      note('a', 0, 2, 60),
      note('b', 1, 1, 62),
      note('c', 4, 1, 64, { confidence: 0.3 }),
      note('d', 5, 1, 65, { confidence: 0.9 }),
    ]);
    const issues = reviewIssues(p);
    expect(issues.map((i) => [i.noteId, i.kind, i.measure])).toEqual([
      ['b', 'overlap', 1],
      ['c', 'low-confidence', 2],
    ]);
    expect(nextIssue(p, issues, undefined, 0, 1)?.noteId).toBe('b');
    expect(nextIssue(p, issues, undefined, 3, 1)?.noteId).toBe('c');
    expect(nextIssue(p, issues, sel(p, 'c'), 0, 1)?.noteId).toBe('b');
    expect(nextIssue(p, issues, sel(p, 'b'), 0, -1)?.noteId).toBe('c');
    expect(nextIssue(p, [], undefined, 0, 1)).toBeUndefined();
  });
  it('editing a flagged note clears its uncalibrated score', () => {
    const p = project([note('c', 0, 1, 64, { confidence: 0.3 })]);
    expect(reviewIssues(setNotePitch(p, sel(p, 'c'), 65))).toEqual([]);
  });
});
