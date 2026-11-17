import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { moveChord, parseChord, setChordAt, unreadableChords } from '../src/lib/chordSymbols';
import { reviewIssues } from '../src/lib/noteInput';
import type { ScoreProject } from '../src/lib/types';

const pcs = (text: string) => parseChord(text)?.pitches.map((pitch) => pitch % 12);

describe('chord vocabulary shared with the OMR text layer', () => {
  it('reads the spellings printed in real lead sheets', () => {
    expect(pcs('FMaj7')).toEqual([5, 9, 0, 4]);
    expect(pcs('F6')).toEqual([5, 9, 0, 2]);
    expect(pcs('F+')).toEqual([5, 9, 1]);
    expect(pcs('G#dim7')).toEqual([8, 11, 2, 5]);
    expect(pcs('Dm7b5')).toEqual([2, 5, 8, 0]);
    expect(pcs('Bø')).toEqual([11, 2, 5, 9]);
    expect(pcs('C7sus4')).toEqual([0, 5, 7, 10]);
    expect(pcs('B♭7')).toEqual([10, 2, 5, 8]);
    expect(pcs('B7/D#')).toEqual([11, 3, 6, 9]); // bass already a chord tone
    expect(pcs('C/Bb')).toEqual([0, 4, 7, 10]); // added below
    expect(parseChord('N.C.')).toEqual({ symbol: 'N.C.', pitches: [], noChord: true });
  });
  it('refuses OMR misreads instead of guessing', () => {
    expect(parseChord('B66')).toBeUndefined();
    expect(parseChord('Verse')).toBeUndefined();
  });
  it('keeps the printed suffix and writes a standard kind through MusicXML', () => {
    const p = createBlankProject();
    p.chords = ['FMaj7', 'F6', 'C+', 'G#dim7', 'Dm7b5', 'D7/F#'].map((symbol, index) => ({
      start: index * 4,
      duration: 4,
      symbol,
      pitches: parseChord(symbol)!.pitches,
    }));
    p.measures = 6;
    const xml = toMusicXml(p);
    expect(xml).toContain('<kind text="Maj7">major-seventh</kind>');
    expect(xml).toContain('<kind text="+">augmented</kind>');
    expect(xml).toContain('<kind text="6">major-sixth</kind>');
    const back = fromMusicXml(xml);
    expect(back.chords.map((chord) => chord.symbol)).toEqual([
      'FMaj7',
      'F6',
      'C+',
      'G#dim7',
      'Dm7b5',
      'D7/F#',
    ]);
    expect(back.chords[0].pitches).toEqual(p.chords[0].pitches);
  });
});

describe('editing the chord track', () => {
  const project = (): ScoreProject => {
    const p = createBlankProject();
    p.measures = 4;
    p.chords = [
      { start: 0, duration: 8, symbol: 'C', pitches: [48, 52, 55] },
      { start: 8, duration: 8, symbol: 'G7', pitches: [55, 59, 62, 65] },
    ];
    return p;
  };
  const track = (p: ScoreProject) => p.chords.map((chord) => [chord.symbol, chord.start, chord.duration]);
  it('replaces, inserts mid-chord (the earlier chord now ends there), and deletes', () => {
    const replaced = setChordAt(project(), 8, 'G7sus4').project;
    expect(track(replaced)).toEqual([
      ['C', 0, 8],
      ['G7sus4', 8, 8],
    ]);
    const inserted = setChordAt(project(), 4, 'Am').project;
    expect(track(inserted)).toEqual([
      ['C', 0, 4],
      ['Am', 4, 4],
      ['G7', 8, 8],
    ]);
    const deleted = setChordAt(inserted, 4, '').project;
    expect(track(deleted)).toEqual([
      ['C', 0, 8],
      ['G7', 8, 8],
    ]);
    expect(validateProject(inserted)).toEqual([]);
  });
  it('N.C. cuts the sounding chord and survives MusicXML export as a gap', () => {
    const p = setChordAt(project(), 4, 'N.C.').project;
    expect(track(p)).toEqual([
      ['C', 0, 4],
      ['G7', 8, 8],
    ]);
    expect(toMusicXml(p)).toContain('<kind text="N.C.">none</kind>');
    expect(track(fromMusicXml(toMusicXml(p)))).toEqual([
      ['C', 0, 4],
      ['G7', 8, 8],
    ]);
  });
  it('rejects text that is not a chord, with an example in the message', () => {
    expect(() => setChordAt(project(), 4, 'Hm7')).toThrow('不是可识别的和弦');
  });
  it('moves a misplaced OMR chord to the right beat; refuses to stack two on one beat', () => {
    const moved = moveChord(project(), 1, 9).project;
    expect(track(moved)).toEqual([
      ['C', 0, 9],
      ['G7', 9, 7],
    ]);
    expect(() => moveChord(project(), 1, 0)).toThrow('该拍已有和弦');
  });
  it('engraves edited symbols on the harmony lane', () => {
    const p = setChordAt(project(), 4, 'Am7').project;
    expect(toAbc(p).abc).toContain('"Am7"');
  });
  it('unreadable OMR chord text is queued for review, not silently dropped', () => {
    const p = project();
    p.chords[1] = { ...p.chords[1], symbol: 'B66' };
    expect(unreadableChords(p)).toEqual([{ index: 1, symbol: 'B66', measure: 3 }]);
    const issue = reviewIssues(p).find((item) => item.kind === 'chord-unreadable')!;
    expect([issue.measure, issue.message]).toEqual([3, '和弦“B66”无法识别，播放与编配时被忽略']);
    expect(
      reviewIssues(setChordAt(p, 8, 'Bb6').project).some((item) => item.kind === 'chord-unreadable'),
    ).toBe(false);
  });
});
