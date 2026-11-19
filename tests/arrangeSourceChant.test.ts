import { describe, expect, it } from 'vitest';
import { arrangeForVoices } from '../src/lib/arrange';
import { chantSourceOptions, defaultChantSelection } from '../src/lib/arrangeSourceChant';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toMusicXml, validateProject } from '../src/lib/music';
import type { ArrangementOptions, NoteEvent, ScoreProject } from '../src/lib/types';

const n = (id: string, midi: number, start: number, duration: number, staff?: number): NoteEvent => ({
  id, midi, start, duration, velocity: 0.7, origin: 'manual', ...(staff ? { staff } : {}),
});

/** Four bars: melody plus a piano with block chords (upper) and bass (lower), as two parts or one grand staff. */
function song(grandStaff: boolean): ScoreProject {
  const project = createBlankProject();
  project.measures = 4;
  const template = project.parts[0];
  const chords = [[60, 64, 67], [57, 60, 65], [55, 59, 62], [60, 64, 67]];
  const bass = [48, 41, 43, 36];
  const melody = { ...structuredClone(template), id: 'melody', name: 'Voice', role: 'lead' as const, program: 52,
    notes: [72, 74, 76, 77, 76, 74, 72, 71].map((m, i) => n(`m${i}`, m, i * 2, 2)) };
  const upper = chords.flatMap((c, bar) => c.map((m, k) => n(`u${bar}${k}`, m, bar * 4, 4, grandStaff ? 1 : undefined)));
  const low = bass.map((m, bar) => n(`b${bar}`, m, bar * 4, 4, grandStaff ? 2 : undefined));
  const piano = { ...structuredClone(template), program: 0, role: 'instrument' as const };
  project.parts = grandStaff
    ? [melody, { ...piano, id: 'piano', name: 'Piano', staves: [{ number: 1, clef: 'treble' as const }, { number: 2, clef: 'bass' as const }], notes: [...upper, ...low] }]
    : [melody, { ...piano, id: 'rh', name: 'Piano', notes: upper }, { ...piano, id: 'lh', name: 'Piano', role: 'bass', clef: 'bass', notes: low }];
  return project;
}
const base: ArrangementOptions = { preset: 'solo-satb', style: 'pop', difficulty: 'medium', percussion: false, transpose: 0, leadPartId: 'melody' };
const pcs = (project: ScoreProject, beat: number) =>
  new Set(project.parts.slice(1).flatMap((p) => p.notes.filter((x) => x.midi !== null && x.start <= beat && x.start + x.duration > beat).map((x) => x.midi! % 12)));
const soloOf = (p: ScoreProject) => p.parts[0].notes.map(({ midi, start, duration, lyric }) => ({ midi, start, duration, lyric }));

describe('source-chant experimental arrangement', () => {
  it('keeps the default Solo + SATB path unchanged when no engine is chosen', () => {
    const source = song(false);
    const unset = arrangeForVoices(source, base);
    const explicit = arrangeForVoices(source, { ...base, engine: 'v2' });
    const strip = (p: ScoreProject) => p.parts.map((part) => part.notes.map(({ midi, start, duration, lyric }) => [midi, start, duration, lyric]));
    expect(strip(unset)).toEqual(strip(explicit));
    expect(unset.arrangement?.options.engine).toBeUndefined();
  });

  it.each([false, true])('builds SATB from the source chords with the Solo untouched (grand staff: %s)', (grandStaff) => {
    const source = song(grandStaff);
    const selection = defaultChantSelection(source, 'melody');
    expect(selection.accompanimentIds).toHaveLength(2);
    const chant = arrangeForVoices(source, { ...base, engine: 'source-chant', ...selection });
    expect(validateProject(chant)).toEqual([]);
    expect(soloOf(chant)).toEqual(soloOf(arrangeForVoices(source, base)));
    expect(chant.parts.map((p) => p.shortName)).toEqual(['Solo', 'S.', 'A.', 'T.', 'B.']);
    // Every bar's backing sounds exactly the source chord's pitch classes; the bass sings the source bass.
    [[0, [0, 4, 7], 0], [4, [9, 0, 5], 5], [8, [7, 11, 2], 7], [12, [0, 4, 7], 0]].forEach(([beat, chord, low]) => {
      expect(pcs(chant, (beat as number) + 1)).toEqual(new Set(chord as number[]));
      const b = chant.parts[4].notes.find((x) => x.midi !== null && x.start <= (beat as number) + 1 && x.start + x.duration > (beat as number) + 1);
      expect(b!.midi! % 12).toBe(low);
    });
    expect(chant.arrangement?.options.engine).toBe('source-chant');
    expect(chant.arrangement?.report.changes[0]).toContain('源谱吟唱');
    const back = fromMusicXml(toMusicXml(chant));
    expect(back.parts).toHaveLength(5);
  });

  it('splits a grand staff into two selectable sources and names duplicate tracks apart', () => {
    expect(chantSourceOptions(song(true), 'melody').map((o) => o.label)).toEqual(['Piano · 第 1 谱表', 'Piano · 第 2 谱表']);
    expect(chantSourceOptions(song(false), 'melody').map((o) => o.label)).toEqual(['Piano（第 2 轨）', 'Piano（第 3 轨）']);
  });

  it('transposes the source harmony together with the Solo', () => {
    const chant = arrangeForVoices(song(false), { ...base, engine: 'source-chant', transpose: 2 });
    expect(pcs(chant, 1)).toEqual(new Set([2, 6, 9]));
    expect(chant.parts[0].notes[0].midi).toBe(74);
  });

  it('refuses a lead sheet with no accompaniment instead of inventing harmony', () => {
    const source = song(false);
    source.parts = source.parts.slice(0, 1);
    expect(chantSourceOptions(source, 'melody')).toEqual([]);
    expect(() => arrangeForVoices(source, { ...base, engine: 'source-chant' })).toThrow('源谱吟唱需要');
  });
});

describe('workbench score-led arrangements', () => {
  it('retains source section boundaries after shortening a chant interlude', () => {
    const source = song(false);
    source.source.arrangementSections = [
      { id: 'interlude', kind: 'interlude', label: 'Interlude', startBar: 1, bars: 1, energy: 1, texture: 'pad', bass: 'sustain' },
      { id: 'return', kind: 'chorus', label: 'Return', startBar: 2, bars: 3, energy: 4, texture: 'answer', bass: 'pulse' },
    ];
    const result = arrangeForVoices(source, { ...base, engine: 'open-chant' });
    expect(result.arrangement?.plan?.sections).toEqual(source.source.arrangementSections);
  });

  it.each(['open-chant', 'lyrical', 'groove', 'jazz-ballad'] as const)('%s regenerates from a fresh written score', engine => {
    const initial = song(false);
    const source = fromMusicXml(toMusicXml(initial));
    const lead = source.parts[0];
    const options = { ...base, engine, leadPartId: lead.id };
    const first = arrangeForVoices(source, options);
    const again = arrangeForVoices(source, first.arrangement!.options);
    const sounding = (p: ScoreProject) => p.parts.map(part => part.notes.map(({ id, ...event }) => event));
    expect(first.arrangement?.options.engine).toBe(engine);
    expect(validateProject(first)).toEqual([]);
    expect(first.parts.length).toBe(5);
    expect(first.parts.slice(1).some(part => part.notes.length > 0)).toBe(true);
    expect(sounding(first)).toEqual(sounding(again));
    expect(soloOf(first)).toEqual(soloOf(arrangeForVoices(source, { ...options, engine: 'v2' })));
  });
});
