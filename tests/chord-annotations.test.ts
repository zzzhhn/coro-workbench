import abcjs from 'abcjs';
import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { toAbc } from '../src/lib/music';
import type { AbcRenderResult } from '../src/lib/types';

const segments = (result: AbcRenderResult) => [...new Set(Object.values(result.noteSegments!)
  .map((s) => JSON.stringify([s.noteIds, s.start, s.duration])))].sort();

describe('independent timed harmony annotations', () => {
  it('does not split a sixteenth at an interior chord change', () => {
    const project = createBlankProject();
    project.measures = 6;
    project.parts[0].notes = [{ id: 'sung', midi: 65, start: 19.125, duration: .25, velocity: .8, lyric: 'da' }];
    const withoutChords = toAbc(project);
    project.chords = [{ start: 19.25, duration: 4, symbol: 'Fm', pitches: [53, 56, 60] }];
    const before = structuredClone(project);
    const withChords = toAbc(project);
    expect(segments(withChords)).toEqual(segments(withoutChords));
    expect(segments(withChords)).toHaveLength(1);
    expect(withChords.abc.match(/w:.+/g)).toEqual(withoutChords.abc.match(/w:.+/g));
    expect(project).toEqual(before);
  });

  it('keeps chord and no-chord onsets exact in the raw ABC timeline', () => {
    const project = createBlankProject();
    project.measures = 2;
    project.parts[0].notes = [{ id: 'held', midi: 60, start: 0, duration: 8, velocity: .8 }];
    project.chords = [
      { start: .25, duration: 1.5, symbol: 'C', pitches: [48, 52, 55] },
      { start: 2.125, duration: 3, symbol: 'F/A', pitches: [53, 57, 60] },
    ];
    const result = toAbc(project);
    const tune = abcjs.parseOnly(result.abc)[0];
    expect(tune.warnings ?? []).toEqual([]);
    const annotations: Array<[number, string]> = [];
    let cursor = 0;
    const harmonyIndex = result.staffMap![0].voiceIds.indexOf(result.harmonyVoiceId!);
    for (const line of tune.lines) {
      for (const event of line.staff?.[0]?.voices?.[harmonyIndex] ?? []) {
        const item = event as { el_type: string; duration: number; chord?: Array<{ name: string }> };
        if (item.el_type !== 'note') continue;
        if (item.chord) for (const chord of item.chord) annotations.push([cursor, chord.name]);
        cursor += item.duration * 4;
      }
    }
    expect(annotations).toEqual([[0, 'N.C.'], [.25, 'C'], [1.75, 'N.C.'], [2.125, 'F/A'], [5.125, 'N.C.']]);
    expect(cursor).toBe(8);
    const tracks = tune.setUpAudio({ chordsOff: true }).tracks;
    expect(tracks[harmonyIndex].filter((event) => event.cmd === 'note')).toEqual([]);
    const sounded = tracks.flat().filter((event) => event.cmd === 'note');
    expect(sounded.map((event) => [event.pitch, event.start * 4, event.duration * 4])).toEqual([[60, 0, 8]]);
  });

  it('does not force monophonic melody stems upward or map annotation spacers to notes', () => {
    const project = createBlankProject();
    project.parts[0].notes = [{ id: 'high', midi: 84, start: 0, duration: 4, velocity: .8 }];
    project.chords = [{ start: 1, duration: 3, symbol: 'C', pitches: [48, 52, 55] }];
    const result = toAbc(project);
    const tune = abcjs.parseOnly(result.abc)[0];
    const voices = tune.lines.find((line) => line.staff)?.staff?.[0].voices;
    expect(voices?.[0].some((event) => event.el_type === 'stem')).toBe(false);
    for (const event of voices?.[1] ?? [])
      if (event.el_type === 'note' && event.startChar !== undefined) expect(result.noteMap[event.startChar]).toBeUndefined();
  });

  it('keeps an annotation lane on the selected part without creating a new staff', () => {
    const project = createBlankProject();
    project.parts.push({ ...structuredClone(project.parts[0]), id: 'second', name: 'Second' });
    project.chords = [{ start: 1, duration: 3, symbol: 'C', pitches: [48, 52, 55] }];
    const result = toAbc(project, ['second']);
    expect(result.staffMap).toHaveLength(1);
    expect(result.staffMap![0].partId).toBe('second');
    expect(result.staffMap![0].voiceIds).toContain(result.harmonyVoiceId);
    expect(abcjs.parseOnly(result.abc)[0].warnings ?? []).toEqual([]);
  });

  it('gives dense chord changes room rather than compressing four bars onto one system', () => {
    const project = createBlankProject();
    project.measures = 8;
    project.chords = Array.from({ length: 6 }, (_, i) => ({ start: i * .5, duration: .5, symbol: 'Cmaj7', pitches: [48, 52, 55, 59] }));
    expect(toAbc(project).systemMeasures).toEqual([1, 3, 5, 7]);
  });
});

describe('metrical beam groups', () => {
  it.each([
    { meter: [4, 4] as [number, number], starts: Array.from({ length: 12 }, (_, i) => .125 + i * .25), duration: .25, counts: [4, 4, 4] },
    { meter: [6, 8] as [number, number], starts: Array.from({ length: 6 }, (_, i) => i * .5), duration: .5, counts: [3, 3] },
  ])('keeps $meter runs readable without altering note attacks', ({ meter, starts, duration, counts }) => {
    const project = createBlankProject();
    project.measures = 1;
    project.timeSignature = meter;
    project.parts[0].notes = starts.map((start, i) => ({ id: `n${i}`, midi: 60, start, duration, velocity: .8 }));
    const result = toAbc(project);
    const tune = abcjs.parseOnly(result.abc)[0];
    const beams: number[] = [];
    let count = 0;
    for (const event of tune.lines[0].staff![0].voices![0]) {
      if (event.el_type !== 'note' || !event.pitches) continue;
      count++;
      if ((event as { endBeam?: boolean }).endBeam) { beams.push(count); count = 0; }
    }
    expect(beams).toEqual(counts);
    expect(count).toBe(0);
    const notes = tune.setUpAudio({ chordsOff: true }).tracks[0].filter((event) => event.cmd === 'note');
    expect(notes.map((n) => [n.start * 4, n.duration * 4])).toEqual(starts.map((s) => [s, duration]));
  });
});
