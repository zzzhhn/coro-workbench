import { describe, expect, it } from 'vitest';
import abcjs, { type VoiceItemNote } from 'abcjs';
import { expandedViewBox, prepareEngravingTune } from '../src/lib/engraving';
import { createBlankProject } from '../src/lib/demo';
import { toAbc } from '../src/lib/music';

describe('engraving clipping protection', () => {
  it('uses the written treble staff for overlapping generated holds in a score window', () => {
    const project = createBlankProject();
    project.measures = 40;
    project.source = { kind: 'audio', warnings: [], analysis: { transforms: [], quality: { decoderProfile: 'yourmt3' } } };
    const part = project.parts[0];
    Object.assign(part, { name: 'Strings', program: 48, instrument: 'string_ensemble_1', role: 'instrument' });
    part.notes = [
      { id: 'first', midi: 66, start: 129, duration: 0.375, staff: 1, voice: 'held-1', velocity: 0.8 },
      { id: 'run', midi: 76, start: 128.75, duration: 0.25, staff: 1, voice: 'run-1', velocity: 0.8 },
      { id: 'inner', midi: 66, start: 129, duration: 1, staff: 1, voice: 'held-2', velocity: 0.8 },
      { id: 'bass', midi: 52, start: 130, duration: 1.5, staff: 2, voice: 'low-1', velocity: 0.8 },
      { id: 'a4', midi: 69, start: 135.5, duration: 4, staff: 1, voice: 'held-2', velocity: 0.8 },
      { id: 'g4', midi: 67, start: 136.5, duration: 3, staff: 1, voice: 'held-3', velocity: 0.8 },
    ].sort((a, b) => a.start - b.start);
    const before = structuredClone(project);
    const full = toAbc(project);
    expect(full.staffMap?.map((staff) => staff.staffNumber)).toEqual([1, 3, 2]);

    for (const start of [33, 35]) {
      const result = toAbc(project, undefined, { measureRange: { start, end: start + 3 } });
      const tune = prepareEngravingTune(abcjs.parseOnly(result.abc)[0], result);
      const system = tune.lines.filter((line) => line.staff)[result.systemMeasures!.indexOf(35)];
      expect(result.staffMap?.map((staff) => staff.staffNumber)).toEqual([1, 2]);
      expect(system.staff?.[0].voices).toHaveLength(2);
      const starts = system.staff?.[0].voices?.flatMap((voice, lane) =>
        (voice ?? []).flatMap((event) => {
          if (event.el_type !== 'note' || event.startChar === undefined) return [];
          const segment = result.noteSegments?.[event.startChar];
          return segment ? [{ lane, id: segment.noteIds[0], start: segment.start }] : [];
        }),
      );
      const a4 = starts?.find((event) => event.id === 'a4');
      const g4 = starts?.find((event) => event.id === 'g4');
      expect(a4?.start).toBe(136);
      expect(g4?.start).toBe(136.5);
      expect(a4?.lane).not.toBe(g4?.lane);
    }
    expect(project).toEqual(before);
    expect(toAbc(project)).toEqual(full);
  });

  it('hides an empty auxiliary staff per system while keeping the basic staves and every pitch', () => {
    const project=createBlankProject();project.measures=8;
    const part=project.parts[0];part.program=48;part.role='instrument';part.name='Strings';part.instrument='string_ensemble_1';
    part.staves=[{number:1,clef:'treble'},{number:2,clef:'bass'}];
    part.notes=[{id:'first',midi:60,start:0,duration:2,velocity:.8,staff:1,voice:'1'},
      {id:'bass',midi:48,start:0,duration:2,velocity:.8,staff:2,voice:'1'},
      ...[60,64,67,71].map((midi,i)=>({id:`late-${i}`,midi,start:16,duration:4,velocity:.8,staff:1,voice:String(i+1)}))];
    const result=toAbc(project);const raw=abcjs.parseOnly(result.abc)[0];
    const count=(tune:typeof raw)=>tune.lines.flatMap(line=>line.staff??[]).flatMap(staff=>staff.voices??[]).flat()
      .filter(event=>event.el_type==='note'&&'pitches' in event).reduce((sum,event)=>sum+('pitches' in event?(event.pitches?.length??0):0),0);
    const prepared=prepareEngravingTune(abcjs.parseOnly(result.abc)[0],result);
    expect(raw.lines.find(line=>line.staff)?.staff).toHaveLength(3);
    expect(prepared.lines.find(line=>line.staff)?.staff).toHaveLength(2);
    expect(prepared.lines.some(line=>line.staff?.length===3)).toBe(true);
    expect(count(prepared)).toBe(count(raw));
  });
  it('renders sub-128th boundaries with supported heads and exact spacing durations', () => {
    const project = createBlankProject();
    project.parts[0].notes = [{ id: 'tiny', midi: 60, start: 0, duration: 7 / 960, velocity: .8 },
      { id: 'later', midi: 64, start: 1 / 3, duration: 1 / 3, velocity: .8 }];
    const result = toAbc(project);
    const before = JSON.stringify(project);
    const raw = abcjs.parseOnly(result.abc)[0];
    const prepared = prepareEngravingTune(abcjs.parseOnly(result.abc)[0], result);
    type SpacingNote = VoiceItemNote & { tripletMultiplier?: number };
    const events = (tune: typeof raw) => tune.lines.flatMap((line) => line.staff?.flatMap((staff) => staff.voices?.flat() ?? []) ?? [])
      .filter((event): event is SpacingNote => event?.el_type === 'note');
    const original = events(raw), modified = events(prepared);
    expect(modified).toHaveLength(original.length);
    modified.forEach((event, i) => {
      expect(event.duration * (event.tripletMultiplier ?? 1)).toBeCloseTo(original[i].duration * (original[i].tripletMultiplier ?? 1), 10);
    });
    expect(JSON.stringify(project)).toBe(before);
  });
  it('expands dense lyrics to include the actual right edge', () => {
    const fitted = expandedViewBox(
      { x: 0, y: 0, width: 930, height: 650 },
      { x: 10, y: 20, width: 1040, height: 600 },
    );
    expect(fitted.width).toBeGreaterThanOrEqual(1062);
    expect(fitted.height).toBeGreaterThanOrEqual(650);
  });
  it('preserves non-zero system coordinates on later PDF pages', () => {
    const fitted = expandedViewBox(
      { x: 0, y: 650, width: 930, height: 550 },
      { x: 10, y: 670, width: 1000, height: 520 },
    );
    expect(fitted.y).toBe(650);
    expect(fitted.height).toBe(550);
    expect(fitted.y + fitted.height).toBe(1200);
  });
  it('uses consistent staff scale across all systems', () => {
    const fitted = expandedViewBox(
      { x: 0, y: 1200, width: 930, height: 550 },
      { x: 8, y: 1210, width: 880, height: 500 },
      1062,
    );
    expect(fitted.width).toBe(1062);
    expect(fitted.y).toBe(1200);
  });
});
