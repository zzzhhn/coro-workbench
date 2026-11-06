import { describe, expect, it } from 'vitest';
import { createBlankProject, createDemoProject } from '../src/lib/demo';
import { arrangeForVoices } from '../src/lib/arrange';
import { toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { createEngravingPlan, prepareEngravingTune } from '../src/lib/engraving';
import {
  applyPartLyrics,
  quantizeSelection,
  reinterpretBeatUnit,
  setPartStaffLayout,
  transposeSelection,
} from '../src/lib/scoreTools';
import type { RepairSelection } from '../src/lib/scoreTools';
import type { NoteEvent, ScoreProject } from '../src/lib/types';
import abcjs from 'abcjs';

const note = (
  id: string,
  midi: number | null,
  start: number,
  duration: number,
  extra: Partial<NoteEvent> = {},
): NoteEvent => ({
  id,
  midi,
  start,
  duration,
  velocity: 0.8,
  origin: 'transcribed',
  confidence: 0.63,
  ...extra,
});

function fixture(): ScoreProject {
  const project = createBlankProject();
  project.measures = 4;
  project.parts[0].id = 'lead';
  project.parts[0].notes = [
    note('before', 60, 0, 1),
    note('entering', 60, 3, 2),
    note('inside', 64, 4.3, 0.43),
    note('end', 67, 7.7, 0.2),
    note('leaving', 69, 7.25, 1.5),
    note('after', 72, 8, 1),
    note('rest', null, 6.15, 0.35),
  ];
  project.parts.push({
    ...structuredClone(project.parts[0]),
    id: 'other',
    name: '其他',
    notes: [note('inside', 48, 4.3, 0.43)],
    role: 'bass',
    clef: 'bass',
  });
  project.chords = [
    { start: 0, duration: 8, symbol: 'C', pitches: [48, 52, 55], confidence: 0.7 },
    { start: 8, duration: 8, symbol: 'F/A', pitches: [45, 53, 57, 60], confidence: 0.8 },
  ];
  return project;
}

const region: RepairSelection = { partIds: ['lead'], startMeasure: 2, endMeasure: 2 };

describe('bounded transpose preview', () => {
  it('edits only selected onsets, leaves entering ties/other parts/global harmony unchanged', () => {
    const source = fixture();
    const snapshot = structuredClone(source);
    const result = transposeSelection(source, region, 2);
    expect(source).toEqual(snapshot);
    expect(result.project).not.toBe(source);
    expect(result.project.id).toBe(source.id);
    expect(result.changedNotes).toBe(3);
    expect(result.project.parts[1]).toEqual(source.parts[1]);
    expect(result.project.chords).toEqual(source.chords);
    expect(result.project.key).toBe(source.key);
    expect(result.project.parts[0].notes.find((n) => n.id === 'entering')).toEqual(
      source.parts[0].notes.find((n) => n.id === 'entering'),
    );
    expect(result.project.parts[0].notes.find((n) => n.id === 'after')).toEqual(
      source.parts[0].notes.find((n) => n.id === 'after'),
    );
    expect(result.project.parts[0].notes.find((n) => n.id === 'inside')).toMatchObject({
      midi: 66,
      start: 4.3,
      duration: 0.43,
      origin: 'manual',
    });
    expect(result.project.parts[0].notes.find((n) => n.id === 'inside')!.confidence).toBeUndefined();
    expect(result.project.parts[0].notes.find((n) => n.id === 'rest')!.confidence).toBe(0.63);
    expect(result.warnings.join('')).toContain('延音从选区之前');
    expect(result.warnings.join('')).toContain('不更改全曲调号');
    expect(validateProject(result.project)).toEqual([]);
  });

  it('transposes global key/chords only when the whole pitched score is selected', () => {
    const source = createDemoProject();
    source.parts[0].range = [60, 81];
    const all: RepairSelection = {
      partIds: source.parts.map((part) => part.id),
      startMeasure: 1,
      endMeasure: source.measures,
    };
    const result = transposeSelection(source, all, 2);
    expect(result.project.key).toBe('G');
    expect(result.project.chords[0].symbol).toBe('Gmaj7');
    expect(result.project.chords[1].symbol).toBe('D/F#');
    expect(result.project.parts.at(-1)).toEqual(source.parts.at(-1));
    expect(result.changedNotes).toBe(
      source.parts
        .filter((part) => part.role !== 'percussion')
        .reduce((total, part) => total + part.notes.filter((note) => note.midi !== null).length, 0),
    );
    expect(result.project.parts[0].range).toEqual([60, 81]);
  });

  it('rejects range overflow and invalid selections atomically', () => {
    const source = fixture();
    source.parts[0].notes[2].midi = 127;
    const snapshot = JSON.stringify(source);
    expect(() => transposeSelection(source, region, 1)).toThrow('MIDI');
    expect(JSON.stringify(source)).toBe(snapshot);
    for (const selection of [
      { ...region, partIds: ['missing'] },
      { ...region, startMeasure: 0 },
      { ...region, endMeasure: 9 },
      { ...region, partIds: [] },
      { ...region, endMeasure: 1 },
    ])
      expect(() => transposeSelection(source, selection, 1)).toThrow('有效');
    expect(() => transposeSelection(source, region, 0.5)).toThrow('整数半音');
    expect(() => transposeSelection(source, region, 25)).toThrow('整数半音');
  });

  it('returns a genuine no-op clone for zero semitones', () => {
    const source = fixture();
    const result = transposeSelection(source, region, 0);
    expect(result.project).toEqual(source);
    expect(result.project).not.toBe(source);
    expect(result.changedNotes).toBe(0);
    result.project.parts[0].notes[0].midi = 80;
    expect(source.parts[0].notes[0].midi).toBe(60);
  });
});

describe('explicit quantization', () => {
  it('aligns selected endpoints while preserving all notes and outside endpoints', () => {
    const source = fixture();
    const snapshot = structuredClone(source);
    const result = quantizeSelection(source, region, 0.5);
    expect(source).toEqual(snapshot);
    expect(result.project.measures).toBe(source.measures);
    expect(result.project.parts[0].notes).toHaveLength(source.parts[0].notes.length);
    expect(result.project.parts[1]).toEqual(source.parts[1]);
    expect(result.project.parts[0].notes.find((n) => n.id === 'inside')).toMatchObject({
      start: 4.5,
      duration: 0.5,
      midi: 64,
      origin: 'manual',
    });
    expect(result.project.parts[0].notes.find((n) => n.id === 'end')).toMatchObject({
      start: 7.5,
      duration: 0.5,
    });
    const leaving = result.project.parts[0].notes.find((n) => n.id === 'leaving')!;
    expect(leaving.start + leaving.duration).toBe(8.75);
    expect(result.project.parts[0].notes.find((n) => n.id === 'entering')).toEqual(
      source.parts[0].notes.find((n) => n.id === 'entering'),
    );
    expect(result.project.parts[0].notes.find((n) => n.id === 'after')).toEqual(
      source.parts[0].notes.find((n) => n.id === 'after'),
    );
    expect(result.project.parts[0].notes.find((n) => n.id === 'inside')!.confidence).toBeUndefined();
    expect(result.project.chords).toEqual(source.chords);
    expect(validateProject(result.project)).toEqual([]);
  });

  it.each([1, 0.5, 0.25, 2 / 3, 1 / 3, 1 / 6])('supports grid %s with positive durations', (step) => {
    const source = fixture();
    const result = quantizeSelection(source, region, step);
    expect(result.project.parts[0].notes.every((note) => note.duration > 0)).toBe(true);
    expect(validateProject(result.project)).toEqual([]);
    expect(() => toMusicXml(result.project)).not.toThrow();
  });

  it('keeps triplets and their confidence exactly unchanged when already on the grid', () => {
    const source = createBlankProject();
    source.parts[0].notes = [note('b', 62, 2 / 3, 1 / 3), note('a', 60, 1 / 3, 1 / 3)];
    const selection = { partIds: [source.parts[0].id], startMeasure: 1, endMeasure: 1 };
    const result = quantizeSelection(source, selection, 1 / 3);
    expect(result.changedNotes).toBe(0);
    expect(result.project).toEqual(source);
  });

  it('never rounds an onset into the adjacent unselected measure', () => {
    const source = createBlankProject();
    source.timeSignature = [3, 8];
    source.parts[0].notes = [note('last', 60, 1.49, 0.01), note('next', 64, 1.5, 0.5)];
    const selection = { partIds: [source.parts[0].id], startMeasure: 1, endMeasure: 1 };
    const result = quantizeSelection(source, selection, 2 / 3);
    const last = result.project.parts[0].notes.find((note) => note.id === 'last')!;
    expect(last.start).toBeLessThan(1.5);
    expect(last.start + last.duration).toBeLessThanOrEqual(1.5);
    expect(result.project.parts[0].notes.find((note) => note.id === 'next')).toEqual(
      source.parts[0].notes[1],
    );
  });

  it('does not merge repeated pitches quantized to the same start', () => {
    const source = createBlankProject();
    source.parts[0].notes = [note('a', 60, 0.1, 0.5), note('b', 60, 0.2, 0.5)];
    const result = quantizeSelection(
      source,
      { partIds: [source.parts[0].id], startMeasure: 1, endMeasure: 1 },
      0.5,
    );
    expect(result.project.parts[0].notes.map((note) => note.id)).toEqual(['a', 'b']);
    expect(result.project.parts[0].notes.map((note) => note.start)).toEqual([0, 0]);
    const score = toAbc(result.project);
    const tune = prepareEngravingTune(abcjs.parseOnly(score.abc)[0], score);
    expect(
      tune
        .setUpAudio({ chordsOff: true })
        .tracks.flat()
        .filter((event) => event.cmd === 'note'),
    ).toHaveLength(2);
  });

  it.each([0, -1, 0.2, NaN, Infinity])('rejects unsupported grid %s', (step) => {
    expect(() => quantizeSelection(fixture(), region, step)).toThrow('网格');
  });
});

describe('staff-layout correction', () => {
  it('assigns grand-staff hints without changing any acoustic data or source voices', () => {
    const source = fixture();
    source.parts[0].notes.push(note('low', 48, 1, 2, { voice: 'original-voice' }));
    const result = setPartStaffLayout(source, 'lead', 'grand');
    expect(result.project.parts[0].staves).toEqual([
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ]);
    expect(result.changedNotes).toBe(source.parts[0].notes.length);
    result.project.parts[0].notes.forEach((note, index) => {
      const old = source.parts[0].notes[index];
      expect([note.midi, note.start, note.duration, note.velocity, note.confidence, note.voice]).toEqual([
        old.midi,
        old.start,
        old.duration,
        old.velocity,
        old.confidence,
        old.voice,
      ]);
      expect(note.staff).toBe(note.midi !== null && note.midi < 60 ? 2 : 1);
      expect(note.origin).toBe('manual');
    });
    expect(source.parts[0].staves).toBeUndefined();
    expect(result.project.parts[1]).toEqual(source.parts[1]);
    expect(
      createEngravingPlan(result.project)
        .staves.filter((staff) => staff.part.id === 'lead')
        .map((staff) => staff.clef),
    ).toEqual(['treble', 'bass']);
  });

  it('supports single clefs and restores automatic layout without acoustic changes', () => {
    const source = fixture();
    const grand = setPartStaffLayout(source, 'lead', 'grand').project;
    const bass = setPartStaffLayout(grand, 'lead', 'bass');
    expect(bass.project.parts[0].clef).toBe('bass');
    expect(bass.project.parts[0].notes.every((note) => note.staff === 1)).toBe(true);
    const auto = setPartStaffLayout(bass.project, 'lead', 'auto');
    expect(auto.project.parts[0].staves).toBeUndefined();
    expect(auto.project.parts[0].notes.every((note) => note.staff === undefined)).toBe(true);
    expect(auto.project.parts[0].notes.map((note) => [note.midi, note.start, note.duration])).toEqual(
      source.parts[0].notes.map((note) => [note.midi, note.start, note.duration]),
    );
    expect(setPartStaffLayout(auto.project, 'lead', 'auto').changedNotes).toBe(0);
  });

  it('counts metadata-only layout change without claiming note edits and rejects unsupported layouts', () => {
    const source = createBlankProject();
    const result = setPartStaffLayout(source, source.parts[0].id, 'bass');
    expect(result.changedNotes).toBe(0);
    expect(result.project.parts[0].clef).toBe('bass');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(() => setPartStaffLayout(source, 'missing', 'grand')).toThrow('不存在');
    expect(() => setPartStaffLayout(source, source.parts[0].id, 'grand', 128)).toThrow('分界');
    const drums = createDemoProject().parts.at(-1)!;
    source.parts = [drums];
    source.measures = 16;
    expect(() => setPartStaffLayout(source, drums.id, 'grand')).toThrow('打击乐');
  });
});

describe('manual lyric assignment', () => {
  it('assigns whitespace tokens only to highest notes at selected onsets', () => {
    const source = fixture();
    source.parts[0].notes = [
      note('before', 60, 3, 2, { lyric: 'keep-before' }),
      note('lower', 60, 4, 1, { lyric: 'keep-low' }),
      note('upper', 72, 4, 1),
      note('next', 74, 5, 1),
      note('rest', null, 6, 1),
      note('later', 76, 7, 1, { lyric: 'keep-later' }),
      note('outside', 77, 8, 1, { lyric: 'outside' }),
    ];
    const result = applyPartLyrics(source, 'lead', 2, 2, '夜 \n 风');
    expect(result.changedNotes).toBe(2);
    const notes = result.project.parts[0].notes;
    expect(notes.find((note) => note.id === 'upper')).toMatchObject({
      lyric: '夜',
      origin: 'manual',
      confidence: 0.63,
    });
    expect(notes.find((note) => note.id === 'next')).toMatchObject({
      lyric: '风',
      origin: 'manual',
      confidence: 0.63,
    });
    for (const id of ['before', 'lower', 'rest', 'later', 'outside'])
      expect(notes.find((note) => note.id === id)).toEqual(
        source.parts[0].notes.find((note) => note.id === id),
      );
    expect(result.warnings.join('')).toContain('每个起音只给最高音');
    expect(result.warnings.join('')).toContain('剩余 1');
    expect(result.project.parts[1]).toEqual(source.parts[1]);
  });

  it('does not split Chinese characters automatically or erase lyrics on empty input', () => {
    const source = fixture();
    const result = applyPartLyrics(source, 'lead', 2, 2, '没有空格');
    expect(result.changedNotes).toBe(1);
    expect(result.project.parts[0].notes.find((note) => note.id === 'inside')!.lyric).toBe('没有空格');
    const empty = applyPartLyrics(result.project, 'lead', 2, 2, '  \n ');
    expect(empty.project).toEqual(result.project);
    expect(empty.changedNotes).toBe(0);
  });

  it('reports excess tokens without adding or removing any notes', () => {
    const source = fixture();
    const result = applyPartLyrics(source, 'lead', 2, 2, 'one two three four five');
    expect(result.changedNotes).toBe(3);
    expect(result.warnings.join('')).toContain('2 个多余');
    expect(result.project.parts[0].notes).toHaveLength(source.parts[0].notes.length);
  });
});

describe('beat-unit reinterpretation', () => {
  it.each([0.5, 2] as const)(
    'factor %s preserves every score/source onset and duration in seconds',
    (factor) => {
      const source = createDemoProject();
      source.originalAudio = {
        name: 'source.wav',
        url: '/api/audio/id/original.wav',
        duration: 100,
        offsetSeconds: 0.75,
        tempo: 100,
      };
      source.parts[0].notes[0].confidence = 0.7;
      const snapshot = structuredClone(source);
      const result = reinterpretBeatUnit(source, factor);
      expect(source).toEqual(snapshot);
      expect(result.project.tempo).toBe(source.tempo * factor);
      expect(result.project.originalAudio).toEqual({ ...source.originalAudio, tempo: 100 * factor });
      expect(result.project.timeSignature).toEqual(source.timeSignature);
      expect(result.project.parts[0].notes[0].confidence).toBe(0.7);
      source.parts.forEach((part, index) =>
        part.notes.forEach((old, noteIndex) => {
          const next = result.project.parts[index].notes[noteIndex];
          expect((next.start * 60) / result.project.tempo).toBeCloseTo((old.start * 60) / source.tempo, 10);
          expect((next.duration * 60) / result.project.tempo).toBeCloseTo(
            (old.duration * 60) / source.tempo,
            10,
          );
          expect(
            (next.start * 60) / result.project.originalAudio!.tempo! +
              result.project.originalAudio!.offsetSeconds,
          ).toBeCloseTo(
            (old.start * 60) / source.originalAudio!.tempo! + source.originalAudio!.offsetSeconds,
            10,
          );
          expect(next.midi).toBe(old.midi);
          expect(next.id).toBe(old.id);
          expect(next.origin).toBe('manual');
        }),
      );
      source.chords.forEach((chord, index) => {
        expect(result.project.chords[index].start / result.project.tempo).toBeCloseTo(
          chord.start / source.tempo,
          12,
        );
        expect(result.project.chords[index].duration / result.project.tempo).toBeCloseTo(
          chord.duration / source.tempo,
          12,
        );
        expect(result.project.chords[index].pitches).toEqual(chord.pitches);
      });
      expect(result.changedNotes).toBe(source.parts.reduce((sum, part) => sum + part.notes.length, 0));
      expect(result.project.source.analysis?.transforms.at(-1)).toContain(`x${factor}`);
      expect(validateProject(result.project)).toEqual([]);
    },
  );

  it('uses the pre-change score BPM when original audio has no tempo metadata', () => {
    const source = fixture();
    source.tempo = 120;
    source.originalAudio = { name: 'a', url: '/api/audio/a/a.wav', duration: 20, offsetSeconds: 0 };
    expect(reinterpretBeatUnit(source, 0.5).project.originalAudio?.tempo).toBe(60);
  });

  it('pads only silent tail for odd measure counts, retaining original beat detection evidence', () => {
    const source = fixture();
    source.measures = 5;
    source.source.analysis = {
      transforms: ['raw model'],
      rawProjectUrl: '/api/audio/a/raw.json',
      rhythm: { bpm: 100, offsetSeconds: 0.3, beatTimesSeconds: [0.3, 0.9], method: 'test' },
    };
    const result = reinterpretBeatUnit(source, 0.5);
    expect(result.project.measures).toBe(3);
    expect(result.warnings.join('')).toContain('末尾补齐');
    expect(result.project.source.analysis?.rhythm).toEqual(source.source.analysis.rhythm);
    expect(result.project.source.analysis?.rawProjectUrl).toBe(source.source.analysis.rawProjectUrl);
    expect(result.project.source.analysis?.transforms[0]).toBe('raw model');
  });

  it('rejects tempo overflow and oversized results without changing source', () => {
    const source = fixture();
    source.tempo = 300;
    expect(() => reinterpretBeatUnit(source, 2)).toThrow('BPM');
    expect(source.tempo).toBe(300);
    source.tempo = 15;
    expect(() => reinterpretBeatUnit(source, 0.5)).toThrow('BPM');
    source.tempo = 100;
    source.measures = 2048;
    expect(() => reinterpretBeatUnit(source, 2)).toThrow('2048');
    expect(() => reinterpretBeatUnit(source, 3 as 2)).toThrow('半速或倍速');
  });

  it('refreshes vocal range inspection after a real pitch repair', () => {
    const source = arrangeForVoices(createDemoProject(), {
      preset: 'satb',
      style: 'pop',
      difficulty: 'easy',
      percussion: true,
      transpose: 0,
    });
    const result = transposeSelection(
      source,
      { partIds: [source.parts[0].id], startMeasure: 1, endMeasure: source.measures },
      12,
    );
    expect(result.project.arrangement!.report.ranges[0].violations).toBeGreaterThan(0);
    expect(source.arrangement!.report.ranges[0].violations).toBe(0);
  });
});
