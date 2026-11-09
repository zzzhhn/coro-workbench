import { existsSync, readFileSync } from 'node:fs';
import abcjs from 'abcjs';
import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { createEngravingPlan, prepareEngravingTune } from '../src/lib/engraving';
import { fromMusicXml, toAbc, toMusicXml } from '../src/lib/music';
import type { NoteEvent, ScoreProject } from '../src/lib/types';

const noteRows = (notes: NoteEvent[]) => notes.filter(note => note.midi !== null)
  .map(note => [note.staff, note.midi, Math.round(note.start * 960), Math.round(note.duration * 960)])
  .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!);

describe('declared keyboard staves', () => {
  it('keeps independent and overlapping pitches on their written staves in ABC and MusicXML', () => {
    const project = createBlankProject();
    project.measures = 2;
    const part = project.parts[0];
    Object.assign(part, { name: 'Piano', instrument: 'acoustic_grand_piano', role: 'instrument', program: 0 });
    part.staves = [{ number: 1, clef: 'treble' }, { number: 2, clef: 'bass' }];
    part.notes = [
      { id: 'same-a', midi: 67, start: 2, duration: 4.5, staff: 1, voice: 'theme', velocity: .8 },
      { id: 'same-b', midi: 67, start: 3, duration: 2.5, staff: 1, voice: 'theme', velocity: .8 },
      { id: 'inner', midi: 64, start: 3.5, duration: 1, staff: 1, voice: 'inner', velocity: .8 },
      { id: 'top', midi: 72, start: 4, duration: 2, staff: 1, voice: 'top', velocity: .8 },
      { id: 'left', midi: 48, start: 0, duration: 8, staff: 2, voice: 'bass', velocity: .8 },
    ];
    const before = structuredClone(part.notes);
    const result = toAbc(project);
    const tune = prepareEngravingTune(abcjs.parseOnly(result.abc)[0], result);
    expect(tune.warnings ?? []).toEqual([]);
    expect(result.staffMap!.map(staff => staff.staffNumber)).toEqual([1, 2]);
    const systems = tune.lines.filter(line => line.staff);
    expect(systems.length).toBeGreaterThan(0);
    expect(systems.every(line => line.staff?.length === 2)).toBe(true);
    expect(systems[0].staff?.[0].voices).toHaveLength(4);
    const attacks = tune.setUpAudio({ chordsOff: true }).tracks.flatMap(track => track.filter(event => event.cmd === 'note'));
    expect(attacks.map(event => [event.pitch, event.start * 4, event.duration * 4]).sort())
      .toEqual(part.notes.map(note => [note.midi, note.start, note.duration]).sort());

    const xml = toMusicXml(project);
    expect(xml).toContain('<staves>2</staves>');
    const restored = fromMusicXml(xml).parts[0];
    expect(restored.staves).toEqual(part.staves);
    expect(noteRows(restored.notes)).toEqual(noteRows(part.notes));
    expect(restored.notes.filter(note => note.midi === 67).map(note => note.voice))
      .toEqual(['theme', expect.not.stringMatching(/^theme$/)]);
    expect(restored.notes.filter(note => [48, 64, 72].includes(note.midi ?? -1)).map(note => note.voice))
      .toEqual(['bass', 'inner', 'top']);
    expect(part.notes).toEqual(before);
  });

  const path = 'data/2a0d2474991741bfa58773387d4434e8/project.json';
  it.skipIf(!existsSync(path)).each([[25, 28], [57, 60]])('keeps the original Konger piano on two staves in bars %i–%i', (first, last) => {
    const project = JSON.parse(readFileSync(path, 'utf8')) as ScoreProject;
    // The frozen transcription includes a leading alignment bar.
    const start = first * 4, end = (last + 1) * 4;
    const part = project.parts.find(part => part.id === 'piano-0-piano')!;
    project.parts = [part];
    project.chords = [];
    project.measures = last - first + 1;
    part.notes = part.notes.filter(note => note.start < end && note.start + note.duration > start)
      .map(note => ({ ...note, start: Math.max(0, note.start - start),
        duration: Math.min(end, note.start + note.duration) - Math.max(start, note.start) }));
    const plan = createEngravingPlan(project);
    const summary = plan.staves.map(staff => ({ number: staff.number, voices: staff.voices.length }));
    expect(summary.map(staff => staff.number), JSON.stringify(summary)).toEqual([1, 2]);
    expect(summary.some(staff => staff.voices > 2)).toBe(true);
    expect(plan.staves.flatMap(staff => staff.voices.flatMap(voice => voice.groups.flatMap(group => group.notes)))
      .map(note => note.id).sort()).toEqual(part.notes.map(note => note.id).sort());
    const result = toAbc(project);
    const tune = prepareEngravingTune(abcjs.parseOnly(result.abc)[0], result);
    expect(tune.warnings ?? []).toEqual([]);
    expect(tune.lines.filter(line => line.staff).every(line => line.staff?.length === 2)).toBe(true);
    const restored = fromMusicXml(toMusicXml(project)).parts[0];
    expect(restored.staves).toEqual(part.staves);
    expect(noteRows(restored.notes)).toEqual(noteRows(part.notes));
  });
});
