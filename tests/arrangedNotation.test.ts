import abcjs from 'abcjs';
import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { fromMusicXml, toAbc, toMusicXml } from '../src/lib/music';
import { projectArrangementNotation } from '../src/lib/midiNotation';
import type { NoteEvent } from '../src/lib/types';

const phase = 2 / 480;
function fixture() {
  const p = createBlankProject();
  const lead = p.parts[0];
  lead.id = 'solo';
  lead.notes = Array.from({ length: 16 }, (_, i) => ({
    id: 'lead-' + i,
    start: i + phase,
    duration: 0.4729167,
    midi: 70,
    velocity: 0.7,
  }));
  p.source.kind = 'midi';
  p.arrangement = {
    options: { preset: 'solo-satb', style: 'pop', difficulty: 'medium', percussion: false, transpose: 0 },
    report: { ranges: [], warnings: [], changes: [] },
  };
  const events: NoteEvent[] = [2, 3, 4, 5, 6, 7].map((start, i) => ({
    id: 'back-' + i,
    start: start + phase,
    duration: 1,
    origin: 'arranged',
    midi: 60,
    velocity: 0.7,
    lyric: i ? 'oo' : 'Doo',
  }));
  for (const id of ['s', 'a', 't', 'b']) {
    p.parts.push({
      ...lead,
      id,
      role: id === 'b' ? 'bass' : 'harmony',
      notes: events.map((n) => ({ ...n, id: id + n.id })),
    });
  }
  return p;
}

it('carries the same source-clock correction through all background staves and retains measured selection timing', () => {
  const p = fixture(),
    before = structuredClone(p);
  const written = projectArrangementNotation(p);
  for (const part of written.parts.slice(1)) {
    expect(part.notes.map((n) => n.start)).toEqual([2, 3, 4, 5, 6, 7]);
    const abc = toAbc(p, [part.id]);
    const played = abcjs
      .parseOnly(abc.abc)[0]
      .setUpAudio({ chordsOff: true })
      .tracks.flat()
      .filter((n) => n.cmd === 'note');
    expect(played.map((n) => [n.start * 4, n.duration * 4])).toEqual(
      part.notes.map((n) => [n.start, n.duration]),
    );
    for (const segment of Object.values(abc.noteSegments ?? {})) {
      expect(segment.measured?.start).toBeCloseTo(segment.start + phase);
      expect(segment.measured?.duration).toBeCloseTo(1);
    }
    const xml = toMusicXml(p, [part.id]);
    expect(xml).not.toContain('<time-modification>');
    expect(
      fromMusicXml(xml)
        .parts[0].notes.filter((n) => n.midi !== null)
        .map((n) => [n.start, n.duration, n.lyric]),
    ).toEqual(part.notes.map((n) => [n.start, n.duration, n.lyric]));
  }
  expect(p).toEqual(before);
  expect(projectArrangementNotation(written)).toBe(written);
});

it('follows a performed release when a background response starts there, and respects manual notes and approved bars', () => {
  const p = fixture(),
    part = p.parts[1];
  const anchor = p.parts[0].notes[9];
  part.notes.push({ ...part.notes[0], id: 'answer', start: anchor.start + anchor.duration, duration: 0.5 });
  part.notes.push({ ...part.notes[0], id: 'edited', start: 12 + phase, duration: 0.731, origin: 'manual' });
  p.arrangement!.locks = [{ first: 2, last: 2 }];
  const notes = projectArrangementNotation(p).parts[1].notes;
  expect(notes.at(-2)?.start).toBeCloseTo(9.5);
  expect(notes.at(-1)).toBe(part.notes.at(-1));
  expect(notes[3]).toBe(part.notes[3]);
});
