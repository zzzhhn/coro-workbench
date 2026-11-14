import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { createEngravingPlan } from '../src/lib/engraving';
import {
  clearRange,
  copyRange,
  extendRange,
  notesInRange,
  pasteClip,
  rangeBetween,
  rangeFromHits,
  setVoice,
  voiceNumber,
} from '../src/lib/rangeEdit';
import type { NoteEvent, ScoreProject } from '../src/lib/types';

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

function twoParts(): ScoreProject {
  const p = createBlankProject();
  p.measures = 4;
  p.parts[0].notes = [
    n('s1', 0, 4, 72, { lyric: 'a' }),
    n('s2', 4, 2, 74, { lyric: 'b', sourceRef: 'omr-0-1', confidence: 0.4 }),
    n('s3', 6, 2, 76),
    n('s4', 8, 4, 77),
  ];
  p.parts.push({
    ...structuredClone(p.parts[0]),
    id: 'alto',
    name: 'Alto',
    notes: [n('a1', 0, 4, 64), n('a2', 4, 4, 65), n('a3', 8, 4, 67)],
  });
  p.chords = [
    { start: 0, duration: 4, symbol: 'C', pitches: [60, 64, 67] },
    { start: 4, duration: 4, symbol: 'F', pitches: [65, 69, 72] },
  ];
  return p;
}
const S = (p: ScoreProject) => p.parts[0];

describe('range selection', () => {
  it('shift-click spans whole bars and the parts between', () => {
    const p = twoParts();
    const range = rangeBetween(p, { partId: 'piano', noteId: 's2' }, { partId: 'alto', noteId: 'a3' })!;
    expect(range).toEqual({ partIds: ['piano', 'alto'], startBar: 2, endBar: 3 });
    expect(notesInRange(p, range).map((item) => item.noteId)).toEqual(['s2', 's3', 's4', 'a2', 'a3']);
  });
  it('rubber band hits become a rectangular range; hidden parts are excluded', () => {
    const p = twoParts();
    expect(
      rangeFromHits(p, [
        { partId: 'alto', start: 8 },
        { partId: 'piano', start: 4 },
      ]),
    ).toEqual({
      partIds: ['piano', 'alto'],
      startBar: 2,
      endBar: 3,
    });
    expect(rangeFromHits(p, [{ partId: 'piano', start: 0 }], ['alto'])).toBeUndefined();
    expect(extendRange(p, { partIds: ['piano'], startBar: 2, endBar: 2 }, 1).endBar).toBe(3);
    expect(extendRange(p, { partIds: ['piano'], startBar: 2, endBar: 2 }, -1).endBar).toBe(2);
  });
});

describe('copy, cut and paste', () => {
  it('copy is relative to the range and clips notes at its end', () => {
    const p = twoParts();
    S(p).notes.push(n('long', 7, 3, 79));
    const clip = copyRange(p, { partIds: ['piano'], startBar: 2, endBar: 2 });
    expect(clip.parts[0].notes.map((note) => [note.id, note.start, note.duration])).toEqual([
      ['s2', 0, 2],
      ['s3', 2, 2],
      ['long', 3, 1],
    ]);
    expect(clip.chords).toBeUndefined(); // one part only: chords stay put
  });
  it('overwrite paste replaces only target bars, keeps lyrics, drops scan provenance', () => {
    const p = twoParts();
    const clip = copyRange(p, { partIds: ['piano'], startBar: 2, endBar: 2 });
    const { project, range } = pasteClip(p, clip, 'piano', 3, 'overwrite');
    expect(range).toEqual({ partIds: ['piano'], startBar: 3, endBar: 3 });
    expect(S(project).notes.map((note) => [note.midi, note.start, note.duration, note.lyric ?? ''])).toEqual([
      [72, 0, 4, 'a'],
      [74, 4, 2, 'b'],
      [76, 6, 2, ''],
      [74, 8, 2, 'b'],
      [76, 10, 2, ''],
    ]);
    const pasted = S(project).notes.find((note) => note.start === 8)!;
    expect(pasted.sourceRef).toBeUndefined();
    expect(pasted.confidence).toBeUndefined();
    expect(pasted.origin).toBe('manual');
    expect(pasted.id).not.toBe('s2');
    expect(project.parts[1]).toEqual(p.parts[1]);
    expect(project.measures).toBe(4);
    expect(validateProject(project)).toEqual([]);
  });
  it('overwrite shortens a note held into the paste point instead of overlapping it', () => {
    const p = twoParts();
    S(p).notes = [n('held', 2, 4, 60)];
    const clip = copyRange(twoParts(), { partIds: ['piano'], startBar: 3, endBar: 3 });
    const { project } = pasteClip(p, clip, 'piano', 2, 'overwrite');
    expect(S(project).notes.map((note) => [note.start, note.duration])).toEqual([
      [2, 2],
      [4, 4],
    ]);
  });
  it('insert paste of all parts shifts every part and chord and keeps the score aligned', () => {
    const p = twoParts();
    const clip = copyRange(p, { partIds: ['piano', 'alto'], startBar: 1, endBar: 1 });
    expect(clip.chords?.map((chord) => chord.symbol)).toEqual(['C']);
    const { project } = pasteClip(p, clip, 'piano', 2, 'insert');
    expect(project.measures).toBe(5);
    expect(S(project).notes.map((note) => [note.midi, note.start])).toEqual([
      [72, 0],
      [72, 4],
      [74, 8],
      [76, 10],
      [77, 12],
    ]);
    expect(project.parts[1].notes.map((note) => [note.midi, note.start])).toEqual([
      [64, 0],
      [64, 4],
      [65, 8],
      [67, 12],
    ]);
    expect(project.chords.map((chord) => [chord.symbol, chord.start])).toEqual([
      ['C', 0],
      ['C', 4],
      ['F', 8],
    ]);
    expect(() => toAbc(project)).not.toThrow();
  });
  it('cut clears the range; pasting more parts than exist below warns instead of failing', () => {
    const p = twoParts();
    const range = { partIds: ['piano', 'alto'], startBar: 2, endBar: 2 };
    const clip = copyRange(p, range);
    const cut = clearRange(p, range);
    expect(notesInRange(cut, range)).toEqual([]);
    expect(cut.chords.map((chord) => chord.symbol)).toEqual(['C']);
    const result = pasteClip(cut, clip, 'alto', 4, 'overwrite');
    expect(result.warnings.join()).toContain('多出的声部未粘贴');
    expect(result.warnings.join()).toContain('和弦标记属于整首谱');
    expect(result.project.parts[1].notes.some((note) => note.start === 12 && note.midi === 74)).toBe(true);
  });
  it('a grand-staff clip pasted onto a single staff keeps every note on a valid staff', () => {
    const p = twoParts();
    S(p).staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    S(p).notes = [n('rh', 0, 4, 72, { staff: 1, voice: '1' }), n('lh', 0, 4, 48, { staff: 2, voice: '5' })];
    const clip = copyRange(p, { partIds: ['piano'], startBar: 1, endBar: 1 });
    const { project } = pasteClip(p, clip, 'alto', 2, 'overwrite');
    expect(validateProject(project)).toEqual([]);
    expect(
      project.parts[1].notes.filter((note) => note.start === 4).every((note) => note.staff === undefined),
    ).toBe(true);
  });
});

describe('explicit voices 1-4', () => {
  it('moving a note to voice 2 makes the engraver draw two voices with opposite stems', () => {
    const p = twoParts();
    S(p).notes = [n('top', 0, 4, 72), n('bottom', 0, 2, 60), n('b2', 2, 2, 62)];
    const before = createEngravingPlan(p, ['piano']).staves[0].voices.length;
    const moved = setVoice(
      p,
      [
        { partId: 'piano', noteId: 'bottom' },
        { partId: 'piano', noteId: 'b2' },
      ],
      2,
    );
    expect(S(moved).notes.map((note) => [note.id, note.voice])).toEqual([
      ['top', '1'],
      ['bottom', '2'],
      ['b2', '2'],
    ]);
    const voices = createEngravingPlan(moved, ['piano']).staves[0].voices;
    expect(voices.map((voice) => voice.sourceVoice)).toEqual(['1', '2']);
    expect(voices.map((voice) => voice.stem)).toEqual(['up', 'down']);
    expect(before).toBe(2); // automatic split already existed; now it is explicit
    expect(setVoice(moved, [{ partId: 'piano', noteId: 'bottom' }], 2)).toBe(moved);
  });
  it('a lower grand staff keeps MusicXML voice numbering 5-8 and round-trips', () => {
    const xml = readFileSync('tests/fixtures/omr-review/twinkle/source.musicxml', 'utf8');
    const p = fromMusicXml(xml);
    S(p).staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    S(p).notes.push(
      n('lh1', 0, 2, 48, { staff: 2, voice: '5' }),
      n('lh2', 0, 2, 43, { staff: 2, voice: '5' }),
    );
    const moved = setVoice(p, [{ partId: S(p).id, noteId: 'lh2' }], 2);
    const lh2 = S(moved).notes.find((note) => note.id === 'lh2')!;
    expect(lh2.voice).toBe('6');
    expect(voiceNumber(lh2)).toBe(2);
    const back = fromMusicXml(toMusicXml(moved));
    const lower = S(back).notes.filter((note) => note.staff === 2);
    expect(new Set(lower.map((note) => note.voice))).toEqual(new Set(['5', '6']));
  });
});
