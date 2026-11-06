import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { createDemoProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { arrangeForVoices } from '../src/lib/arrange';

describe('audio harmony interchange', () => {
  it('preserves leading, internal and trailing no-chord gaps in MusicXML', () => {
    const project = createDemoProject();
    project.chords = [
      { start: 1, duration: 1.5, symbol: 'C/E', pitches: [48, 52, 55] },
      { start: 9, duration: 3, symbol: 'Dm7', pitches: [50, 53, 57, 60] },
    ];
    const xml = toMusicXml(project);
    expect(xml.match(/<kind text="N.C.">none<\/kind>/g)).toHaveLength(3);
    const restored = fromMusicXml(xml);
    expect(restored.chords).toEqual(project.chords);
    expect(validateProject(restored)).toEqual([]);
    expect(toAbc(project).abc).toContain('"N.C."');
    expect(abcjs.parseOnly(toAbc(project).abc)[0].warnings ?? []).toEqual([]);
  });

  it('retains an all-N analysis through MusicXML and does not re-infer chords', () => {
    const project = createDemoProject();
    project.chords = [];
    project.source.analysis = { transforms: [], quality: { 'harmony.preserveGaps': true } };
    const restored = fromMusicXml(toMusicXml(project));
    expect(restored.chords).toEqual([]);
    const arranged = arrangeForVoices(restored, { preset: 'satb', difficulty: 'medium', style: 'pop', percussion: false, transpose: 0 });
    expect(arranged.chords).toEqual([]);
    expect(arranged.parts.slice(1).every((part) => part.notes.every((note) => note.midi === null))).toBe(true);
  });

  it.each([
    ['C6', [48, 52, 55, 57], 'major-sixth'],
    ['Cm6', [48, 51, 55, 57], 'minor-sixth'],
    ['Cm7b5', [48, 51, 54, 58], 'half-diminished'],
    ['Cdim7', [48, 51, 54, 57], 'diminished-seventh'],
    ['Caug', [48, 52, 56], 'augmented'],
    ['C9', [48, 52, 55, 58, 62], 'dominant-ninth'],
    ['C/Bb', [48, 52, 55, 46], 'major'],
  ] as const)('preserves %s chord tones, not only its printed label', (symbol, pitches, kind) => {
    const project = createDemoProject();
    project.chords = [{ start: 0, duration: 64, symbol, pitches: [...pitches] }];
    const xml = toMusicXml(project);
    expect(xml).toContain(`>${kind}</kind>`);
    expect(fromMusicXml(xml).chords).toEqual(project.chords);
  });
});
