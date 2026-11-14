import { describe, expect, it } from 'vitest';
import { arrangeV2, defaultArrangementPlan } from '../src/lib/arrangeV2';
import abcjs from 'abcjs';
import { arrangeForVoices, inferChords, inspectArrangement, recommendLeadPart } from '../src/lib/arrange';
import { createBlankProject, createDemoProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import type { ArrangementOptions, NoteEvent, ScoreProject } from '../src/lib/types';
import { createEngravingPlan } from '../src/lib/engraving';

const BASE: ArrangementOptions = {
  preset: 'satb',
  style: 'pop',
  difficulty: 'medium',
  percussion: true,
  transpose: 0,
};
const note = (id: string, midi: number | null, start: number, duration: number): NoteEvent => ({
  id,
  midi,
  start,
  duration,
  velocity: 0.75,
  origin: 'manual',
});
const hasCrossing = (project: ScoreProject): boolean => {
  const voices = project.parts.filter((part) => part.role !== 'percussion');
  for (let i = 1; i < voices.length; i++)
    for (const low of voices[i].notes)
      for (const high of voices[i - 1].notes) {
        if (
          low.midi !== null &&
          high.midi !== null &&
          low.start < high.start + high.duration - 0.00001 &&
          high.start < low.start + low.duration - 0.00001 &&
          low.midi > high.midi
        )
          return true;
      }
  return false;
};

describe('non-destructive a cappella arranger', () => {
  it('keeps default accompaniment and beatbox notation readable without tiny release rests', () => {
    const result = arrangeForVoices(createDemoProject(), BASE);
    for (const part of result.parts.slice(1, 4)) {
      expect(part.notes.filter((note) => note.midi !== null).every((note) => note.duration % 0.5 === 0)).toBe(
        true,
      );
    }
    const percussion = result.parts.find((part) => part.role === 'percussion')!;
    expect(
      percussion.notes
        .filter((note) => note.midi !== null)
        .every((note) => note.duration === 1 && note.articulation === 'staccato'),
    ).toBe(true);
  });
  it.each(['satb', 'ssaa', 'ttbb'] as const)(
    'builds singable %s voices, breaths and separate VP',
    (preset) => {
      const source = createDemoProject();
      const original = JSON.stringify(source);
      const result = arrangeForVoices(source, { ...BASE, preset });
      expect(JSON.stringify(source)).toBe(original);
      expect(result.id).not.toBe(source.id);
      expect(result.parts).toHaveLength(5);
      expect(result.source.kind).toBe('demo');
      expect(validateProject(result)).toEqual([]);
      expect(result.arrangement?.report.ranges.every((range) => range.violations === 0)).toBe(true);
      expect(result.parts.every((part) => part.notes.some((note) => note.midi !== null))).toBe(true);
      expect(hasCrossing(result)).toBe(false);
      expect(result.parts.slice(0, 4).every((part) => part.notes.some((note) => note.midi === null))).toBe(
        true,
      );
      expect(result.parts[4].notes.some((note) => note.lyric === 'B')).toBe(true);
      const tunes = abcjs.parseOnly(toAbc(result).abc);
      expect((tunes[0] as unknown as { warnings?: string[] }).warnings ?? []).toEqual([]);
    },
  );

  it('preserves in-range source melody pitches/onsets and original lyrics', () => {
    const source = createDemoProject();
    source.parts[0].notes[0].lyric = '夜';
    const result = arrangeForVoices(source, BASE);
    const original = source.parts[0].notes.filter((note) => note.midi !== null);
    const melody = result.parts[0].notes.filter((note) => note.midi !== null);
    expect(melody.map((note) => [note.start, note.midi])).toEqual(
      original.map((note) => [note.start, note.midi]),
    );
    expect(melody[0].lyric).toBe('夜');
    expect(melody.every((note, index) => note.duration <= original[index].duration)).toBe(true);
  });
  it('projects a grand-staff source onto one vocal staff instead of carrying RH/LH metadata', () => {
    const source = createBlankProject();
    source.measures = 2;
    source.parts[0].staves = [{ number: 1, clef: 'treble' }, { number: 2, clef: 'bass' }];
    source.parts[0].notes = [
      { ...note('rh', 67, 0, 2), staff: 1, voice: '1' },
      { ...note('lh', 55, 2, 2), staff: 2, voice: '2' },
    ];
    source.chords = [{ start: 0, duration: 8, symbol: 'C', pitches: [48, 52, 55] }];
    const before = structuredClone(source);
    const result = arrangeForVoices(source, BASE);
    expect(result.parts[0].notes.every((n) => n.staff === undefined && n.voice === undefined)).toBe(true);
    expect(createEngravingPlan(result).staves.filter((staff) => staff.part.id === 'voice-1')).toHaveLength(1);
    expect(source).toEqual(before);
  });

  it('style, difficulty, transpose and percussion choices change actual output', () => {
    const source = createDemoProject();
    const pop = arrangeForVoices(source, BASE);
    const choral = arrangeForVoices(source, { ...BASE, style: 'choral', percussion: false });
    const jazz = arrangeForVoices(source, { ...BASE, style: 'jazz', difficulty: 'advanced' });
    const easy = arrangeForVoices(source, { ...BASE, difficulty: 'easy' });
    const transposed = arrangeForVoices(source, { ...BASE, transpose: -2 });
    expect(choral.parts).toHaveLength(4);
    expect(choral.parts[1].notes.filter((note) => note.midi !== null).length).toBeLessThan(
      pop.parts[1].notes.filter((note) => note.midi !== null).length,
    );
    expect(jazz.parts[1].notes.filter((note) => note.midi !== null).length).toBeGreaterThan(
      pop.parts[1].notes.filter((note) => note.midi !== null).length,
    );
    expect(jazz.parts[4].notes.filter((note) => note.midi !== null).length).toBeGreaterThan(
      pop.parts[4].notes.filter((note) => note.midi !== null).length,
    );
    expect(easy.parts[0].range![1]).toBeLessThan(pop.parts[0].range![1]);
    expect(transposed.key).toBe('Eb');
    expect(transposed.chords[0].symbol).toBe('Ebmaj7');
    expect(transposed.parts[0].notes[0].midi).toBe(pop.parts[0].notes[0].midi! - 2);
  });

  it('resolves polyphonic lead explicitly and retains all source notes', () => {
    const source = createBlankProject();
    source.measures = 2;
    source.parts[0].notes = [note('low', 48, 0, 4), note('high', 72, 0, 2), note('high2', 74, 2, 2)];
    source.chords = [{ start: 0, duration: 8, symbol: 'C', pitches: [48, 52, 55] }];
    const result = arrangeForVoices(source, BASE);
    expect(source.parts[0].notes).toHaveLength(3);
    expect(result.parts[0].notes.filter((note) => note.midi !== null).map((note) => note.midi)).toEqual([
      72, 74,
    ]);
    expect(result.arrangement?.report.warnings.join('')).toContain('复音');
  });

  it('derives uncertain harmony when none was supplied, never claims it was known', () => {
    const source = createDemoProject();
    source.chords = [];
    const inferred = inferChords(source);
    expect(inferred).toHaveLength(16);
    expect(inferred[0].symbol).toBe('Fmaj7');
    const result = arrangeForVoices(source, BASE);
    expect(result.arrangement?.report.warnings.join('')).toContain('规则推断');
    expect(result.chords.every((chord) => chord.confidence! < 0.9)).toBe(true);
  });

  it('folds extreme melody notes within range with a visible warning', () => {
    const source = createBlankProject();
    source.measures = 2;
    source.parts[0].notes = [note('low', 24, 0, 2), note('high', 105, 2, 2), note('middle', 60, 4, 2)];
    source.chords = [{ start: 0, duration: 8, symbol: 'C', pitches: [48, 52, 55] }];
    const result = arrangeForVoices(source, BASE);
    expect(result.arrangement?.report.ranges.every((range) => range.violations === 0)).toBe(true);
    expect(result.arrangement?.report.warnings.join('')).toContain('八度折叠');
  });

  it('does not invent harmony when the audio explicitly contains no detected chords', () => {
    const source = createDemoProject();
    source.chords = [];
    source.source.analysis = { transforms: [], quality: { 'harmony.preserveGaps': true } };
    const result = arrangeForVoices(source, { ...BASE, percussion: false });
    expect(result.chords).toEqual([]);
    expect(result.parts[0].notes.some((event) => event.midi !== null)).toBe(true);
    expect(result.parts.slice(1).every((part) => part.notes.every((event) => event.midi === null))).toBe(true);
    expect(result.arrangement?.report.warnings.join('')).toContain('没有用旋律重新猜和弦');
    expect(validateProject(result)).toEqual([]);
  });

  it('respects within-bar and multi-bar no-chord gaps in all arrangement styles', () => {
    const source = createDemoProject();
    source.chords = [
      { start: 1, duration: 1.5, symbol: 'C/E', pitches: [48, 52, 55] },
      { start: 9, duration: 3, symbol: 'Dm7', pitches: [50, 53, 57, 60] },
    ];
    source.source.analysis = { transforms: [], quality: { 'harmony.preserveGaps': true } };
    for (const style of ['pop', 'choral', 'jazz'] as const) {
      const result = arrangeForVoices(source, { ...BASE, style, percussion: false });
      expect(result.parts.slice(1).some((part) => part.notes.some((event) => event.midi !== null))).toBe(true);
      for (const part of result.parts.slice(1))
        for (const event of part.notes.filter((event) => event.midi !== null))
          expect(source.chords.some((chord) => event.start >= chord.start && event.start + event.duration <= chord.start + chord.duration)).toBe(true);
    }
  });

  it('exports readable vocal MusicXML with lyrics and reimports the same notes', () => {
    const result = arrangeForVoices(createDemoProject(), BASE);
    const xml = toMusicXml(result);
    expect(xml).toContain('<lyric number="1">');
    expect(xml).toContain('<text>da</text>');
    const restored = fromMusicXml(xml);
    expect(validateProject(restored)).toEqual([]);
    result.parts.forEach((part, index) => {
      const fingerprint = (notes: NoteEvent[]) =>
        notes
          .filter((note) => note.midi !== null)
          .map((note) => [note.midi, note.start, note.duration, note.lyric]);
      expect(fingerprint(restored.parts[index].notes)).toEqual(fingerprint(part.notes));
    });
  });

  it('audits manually introduced range violations and polyphonic vocal mistakes', () => {
    const result = arrangeForVoices(createDemoProject(), BASE);
    result.parts[0].notes[0].midi = 99;
    result.parts[1].notes.push(note('overlap', 85, 0, 1));
    const inspection = inspectArrangement(result);
    expect(inspection.ranges[0].violations).toBe(1);
    expect(inspection.warnings.join('')).toContain('重叠音');
    expect(inspection.warnings.join('')).toContain('超出');
  });

  it('rejects blank or percussion-only sources and invalid settings', () => {
    expect(() => arrangeForVoices(createBlankProject(), BASE)).toThrow('没有');
    const source = createDemoProject();
    source.parts = [source.parts[4]];
    expect(() => arrangeForVoices(source, BASE)).toThrow('打击乐');
    expect(() => arrangeForVoices(createDemoProject(), { ...BASE, transpose: 100 })).toThrow('移调');
  });

  it('keeps SATB abc and XML playback durations identical after style changes', () => {
    for (const style of ['pop', 'choral', 'jazz'] as const) {
      const result = arrangeForVoices(createDemoProject(), { ...BASE, style });
      const engraving = toAbc(result);
      const tune = abcjs.parseOnly(engraving.abc)[0];
      const decoded = tune.setUpAudio({ chordsOff: true });
      const trackParts = engraving.staffMap!.flatMap((staff) => staff.voiceIds.map(() => staff.partId));
      expect(tune.warnings ?? []).toEqual([]);
      expect(decoded.totalDuration * 4).toBeCloseTo(64, 5);
      result.parts.forEach((part) => {
        const actual = decoded.tracks.flatMap((track, index) => trackParts[index] === part.id ? track : [])
          .filter((event) => event.cmd === 'note')
          .map((event) => [
            event.pitch,
            Number((event.start * 4).toFixed(5)),
            Number((event.duration * 4).toFixed(5)),
          ]);
        const expected = part.notes
          .filter((note) => note.midi !== null)
          .map((note) => [note.midi, note.start, note.duration]);
        expect(actual, `${style} ${part.name}`).toEqual(expected);
      });
    }
  });

  it('prefers a sustained melodic part over short model-labeled lead fragments', () => {
    const source = createBlankProject();
    source.source = { kind: 'audio', warnings: [] };
    source.measures = 8;
    const melody = {
      ...structuredClone(source.parts[0]),
      id: 'melodic',
      name: 'Family A',
      instrument: 'model family A',
      role: 'instrument' as const,
      notes: Array.from({ length: 11 }, (_, i) => ({
        ...note(`m${i}`, 69 + (i % 5), i * 2, 0.75),
        origin: 'transcribed' as const,
      })),
    };
    const fragments = {
      ...structuredClone(source.parts[0]),
      id: 'fragments',
      name: 'Family B',
      instrument: 'model family B',
      role: 'lead' as const,
      notes: [note('f1', 50, 3, 2), note('f2', 54, 6, 2)],
    };
    const polyphony = {
      ...structuredClone(source.parts[0]),
      id: 'pad',
      role: 'instrument' as const,
      notes: Array.from({ length: 8 }, (_, i) => [
        note(`p${i}a`, 48, i * 4, 3),
        note(`p${i}b`, 60, i * 4, 3),
        note(`p${i}c`, 64, i * 4, 3),
      ]).flat(),
    };
    source.parts = [fragments, polyphony, melody];
    expect(recommendLeadPart(source)?.id).toBe('melodic');
    const result = arrangeForVoices(source, BASE);
    expect(result.arrangement?.options.leadPartId).toBe('melodic');
    expect(result.parts[0].notes.filter((note) => note.midi !== null)).toHaveLength(11);
    const explicit = arrangeForVoices(source, { ...BASE, leadPartId: 'fragments' });
    expect(explicit.arrangement?.options.leadPartId).toBe('fragments');
  });

  it('honors human-confirmed lead roles even when brief, while sparse ML labels cannot win', () => {
    const source = createDemoProject();
    source.source.kind = 'audio';
    const tiny = {
      ...structuredClone(source.parts[0]),
      id: 'brief',
      role: 'lead' as const,
      roleSource: 'model' as const,
      notes: [note('brief-note', 72, 0, 0.25)],
    };
    source.parts[0].role = 'instrument';
    source.parts.unshift(tiny);
    expect(recommendLeadPart(source)?.id).not.toBe('brief');
    Object.assign(tiny, { roleSource: 'manual' });
    expect(recommendLeadPart(source)?.id).toBe('brief');
    expect(arrangeForVoices(source, BASE).parts[0]).toMatchObject({ roleSource: 'manual' });
    const original = createDemoProject();
    expect(recommendLeadPart(original)?.id).toBe('flute');
    expect(recommendLeadPart(createBlankProject())).toBeUndefined();
  });

  it('retains a separate source audio reference and non-destructive IDs after recommendation', () => {
    const source = createDemoProject();
    source.originalAudio = {
      name: 'original.wav',
      url: '/api/audio/id/original.wav',
      duration: 43,
      offsetSeconds: 0.5,
      tempo: 92,
    };
    const before = structuredClone(source);
    const result = arrangeForVoices(source, BASE);
    expect(source).toEqual(before);
    expect(result.id).not.toBe(source.id);
    expect(result.originalAudio).toEqual(source.originalAudio);
    expect(result.originalAudio).not.toBe(source.originalAudio);
  });

  it('keeps the Solo line exact in Solo + SATB instead of moving it into Soprano range', () => {
    const source = createBlankProject();
    source.measures = 4;
    source.parts[0].notes = [note('a', 43, 0, 1), note('b', 47, 1, 1), note('c', 50, 2, 2), note('d', 45, 4, 4)];
    source.parts[0].notes[0].lyric = 'low';
    source.chords = [
      { start: 0, duration: 4, symbol: 'G', pitches: [43, 47, 50] },
      { start: 4, duration: 4, symbol: 'D', pitches: [50, 54, 57] },
    ];
    const result = arrangeV2(source, { ...BASE, preset: 'solo-satb', percussion: false, leadPartId: source.parts[0].id }, defaultArrangementPlan(source));
    expect(result.parts.map((part) => part.shortName)).toEqual(['Solo', 'S.', 'A.', 'T.', 'B.']);
    expect(result.parts[0].notes.map(({ midi, start, duration, lyric }) => ({ midi, start, duration, lyric }))).toEqual(
      source.parts[0].notes.map(({ midi, start, duration, lyric }) => ({ midi, start, duration, lyric })),
    );
    expect(result.arrangement?.report.changes.join('\n')).toContain('不移八度');
    expect(validateProject(result)).toEqual([]);
  });
});
