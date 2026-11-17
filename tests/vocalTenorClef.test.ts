import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toMusicXml, toAbc, toMidi } from '../src/lib/music';
import { pitchAtStep } from '../src/lib/mouseEntry';

describe('vocal tenor octave clef', () => {
  it('changes notation and mouse placement without changing sounding MIDI or XML pitch', () => {
    const p = createBlankProject(); p.measures = 1;
    p.parts[0].notes = [{ id: 'tenor', start: 0, duration: 4, midi: 60, velocity: 0.7 }];
    p.parts[0].clef = 'bass'; const midi = toMidi(p);
    p.parts[0].clef = 'treble8';
    expect(toMidi(p)).toEqual(midi);
    expect(pitchAtStep('treble8', 0, 'C')).toBe(pitchAtStep('treble', 0, 'C') - 12);
    const xml = toMusicXml(p);
    expect(xml).toContain('<clef-octave-change>-1</clef-octave-change>');
    expect(xml).toContain('<step>C</step><octave>4</octave>');
    const imported = fromMusicXml(xml);
    expect(imported.parts[0].clef).toBe('treble8');
    expect(imported.parts[0].notes.filter(n => n.midi !== null).map(n => n.midi)).toEqual([60]);
    const { abc, noteSegments } = toAbc(p);
    expect(abc).toContain('clef=treble-8 transpose=-12');
    const parsed = abcjs.parseOnly(abc)[0];
    expect(parsed.lines[0].staff?.[0].clef?.type).toBe('treble-8');
    expect(Object.values(noteSegments!).some(n => n.midiPitches?.includes(60))).toBe(true);
    expect(parsed.setUpAudio({ chordsOff: true }).tracks.flat().filter(e => e.cmd === 'note').map(e => e.pitch)).toEqual([60]);
  });
});
