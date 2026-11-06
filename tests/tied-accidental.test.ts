import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { createBlankProject } from '../src/lib/demo';
import { toAbc, toMusicXml, fromMusicXml } from '../src/lib/music';

describe('accidental scope after a bar-crossing tie', () => {
  it.each([
    ['Am', 46, 46],
    ['Am', 46, 45],
    ['F', 47, 47],
    ['F', 47, 46],
    ['G', 53, 53],
    ['G', 53, 54],
  ] as const)('%s: tied %s does not corrupt the following %s attack', (key, held, next) => {
    const project = createBlankProject();
    project.key = key;
    project.measures = 2;
    project.parts[0].clef = 'bass';
    project.parts[0].notes = [
      { id: 'held', midi: held, start: 3.75, duration: 1.75, velocity: .8 },
      { id: 'next', midi: next, start: 6, duration: 1.5, velocity: .8 },
    ];
    const tune = abcjs.parseOnly(toAbc(project).abc)[0];
    const decoded = tune.setUpAudio({ chordsOff: true }).tracks[0].filter((event) => event.cmd === 'note');
    expect(decoded.map((event) => [event.pitch, event.start * 4, event.duration * 4])).toEqual([
      [held, 3.75, 1.75], [next, 6, 1.5],
    ]);
    const xml = fromMusicXml(toMusicXml(project));
    expect(xml.parts[0].notes.filter((note) => note.midi !== null).map((note) => note.midi)).toEqual([held, next]);
  });
});
