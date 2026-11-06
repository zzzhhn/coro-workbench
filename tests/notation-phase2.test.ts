import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { XMLParser } from 'fast-xml-parser';
import { createBlankProject, createDemoProject } from '../src/lib/demo';
import { createEngravingPlan, prepareEngravingTune } from '../src/lib/engraving';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import type { NoteEvent, ScoreProject } from '../src/lib/types';

const note = (
  id: string,
  midi: number | null,
  start: number,
  duration: number,
  metadata: Partial<NoteEvent> = {},
): NoteEvent => ({ id, midi, start, duration, velocity: 0.8, origin: 'manual', ...metadata });
const sort = (a: number[], b: number[]) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2];
const fingerprint = (notes: NoteEvent[]): number[][] =>
  notes
    .filter((note) => note.midi !== null)
    .map((note) => [note.midi!, +note.start.toFixed(6), +note.duration.toFixed(6)])
    .sort(sort);

function decodeScore(project: ScoreProject) {
  const result = toAbc(project);
  const tune = prepareEngravingTune(abcjs.parseOnly(result.abc)[0], result);
  const audio = tune.setUpAudio({ chordsOff: true });
  const trackParts = result.staffMap!.flatMap((staff) => staff.voiceIds.map(() => staff.partId));
  const decoded = new Map<string, number[][]>();
  audio.tracks.forEach((track, index) => {
    const events = decoded.get(trackParts[index]) ?? [];
    events.push(
      ...track
        .filter((event) => event.cmd === 'note')
        .map((event) => [event.pitch, +(event.start * 4).toFixed(6), +(event.duration * 4).toFixed(6)]),
    );
    decoded.set(trackParts[index], events.sort(sort));
  });
  return { result, tune, audio, decoded };
}

describe('Phase 2 non-destructive notation projection', () => {
  it('uses a grand staff for dense piano with no staff exceeding two independent voices', () => {
    const project = createBlankProject();
    project.measures = 8;
    const part = project.parts[0];
    part.role = 'instrument';
    part.notes = [
      note('low', 36, 0, 8),
      note('fifth', 43, 0.5, 6),
      note('third', 52, 1, 4),
      note('c', 60, 1.5, 4),
      note('e', 64, 2, 3),
      note('g', 67, 2.5, 4),
      note('b', 71, 3, 1),
      note('top', 76, 3.5, 2),
    ];
    const before = structuredClone(project);
    const plan = createEngravingPlan(project);
    expect(plan.staves.map((staff) => staff.clef)).toEqual(['treble', 'bass']);
    expect(plan.staves.every((staff) => staff.voices.length <= 2)).toBe(true);
    expect(plan.warnings.join('')).toContain('未删除');
    const { result, tune, audio, decoded } = decodeScore(project);
    expect(project).toEqual(before);
    expect(result.systemMeasures).toEqual([1, 3, 5, 7]);
    expect(tune.warnings ?? []).toEqual([]);
    expect(audio.totalDuration * 4).toBe(32);
    expect(decoded.get(part.id)).toEqual(fingerprint(part.notes));
  });

  it('repairs partial chord ties when chord membership and pitch position change', () => {
    const project = createBlankProject();
    project.measures = 2;
    project.parts[0].notes = [
      note('anchor', 60, 0, 6),
      note('short', 76, 0, 1),
      note('middle', 64, 0.5, 3),
      note('newHigh', 79, 2, 1),
      note('repeat', 64, 4, 0.5),
    ];
    const { decoded, tune, result } = decodeScore(project);
    expect(tune.warnings ?? []).toEqual([]);
    expect(decoded.get(project.parts[0].id)).toEqual(fingerprint(project.parts[0].notes));
    const anchorSegments = Object.values(result.noteSegments!).filter((segment) =>
      segment.noteIds.includes('anchor'),
    );
    expect(new Set(anchorSegments.map((segment) => segment.start)).size).toBeGreaterThan(3);
  });

  it('preserves overlapping repeated MIDI pitches rather than merging note-offs', () => {
    const project = createBlankProject();
    project.measures = 2;
    project.parts[0].notes = [
      note('a', 60, 0, 5),
      note('b', 60, 0.5, 4),
      note('c', 60, 1, 3),
      note('d', 60, 1.5, 2),
      note('e', 64, 0, 2),
    ];
    const { result, decoded } = decodeScore(project);
    expect(result.staffMap!.length).toBeGreaterThan(1);
    expect(result.staffMap!.every((staff) => staff.voiceIds.filter((id) => id !== result.harmonyVoiceId).length <= 2)).toBe(true);
    expect(decoded.get(project.parts[0].id)).toEqual(fingerprint(project.parts[0].notes));
  });

  it('preserves chromatic reattacks after a tie crossing the barline', () => {
    const project = createBlankProject();
    project.measures = 3;
    project.key = 'D';
    project.parts[0].notes = [
      note('chromatic', 70, 2, 4),
      note('new', 70, 6.5, 1),
      note('low', 60, 1, 7),
      note('mid', 66, 1.5, 5),
      note('high', 77, 3, 1),
    ];
    expect(decodeScore(project).decoded.get(project.parts[0].id)).toEqual(
      fingerprint(project.parts[0].notes),
    );
  });

  it('keeps source voice/staff identity, including both hands playing the same pitch', () => {
    const project = createBlankProject();
    project.measures = 2;
    project.source.kind = 'omr';
    const part = project.parts[0];
    part.role = 'instrument';
    part.staves = [
      { number: 1, clef: 'treble' },
      { number: 2, clef: 'bass' },
    ];
    part.notes = [
      note('rh1', 60, 0, 4, { staff: 1, voice: 'RH' }),
      note('rh2', 72, 4, 2, { staff: 1, voice: 'RH' }),
      note('lh1', 60, 0, 2, { staff: 2, voice: 'LH' }),
      note('lh2', 43, 2, 6, { staff: 2, voice: 'LH' }),
    ];
    const xml = toMusicXml(project);
    const dom = new XMLParser({ ignoreAttributes: false }).parse(xml);
    expect(dom['score-partwise'].part.measure[0].attributes.staves).toBe(2);
    expect(dom['score-partwise'].part.measure[0].attributes.clef).toEqual([
      { '@_number': '1', sign: 'G', line: 2 },
      { '@_number': '2', sign: 'F', line: 4 },
    ]);
    const imported = fromMusicXml(xml);
    expect(imported.parts[0].staves).toEqual(part.staves);
    const identities = (notes: NoteEvent[]) =>
      notes
        .filter((note) => note.midi !== null)
        .map((note) => [note.midi, note.start, note.duration, note.staff, note.voice]);
    expect(identities(imported.parts[0].notes)).toEqual(
      identities(part.notes).sort((a, b) => Number(a[1]) - Number(b[1]) || Number(b[0]) - Number(a[0])),
    );
    expect(decodeScore(imported).decoded.get(imported.parts[0].id)).toEqual(fingerprint(part.notes));
    expect(imported.source.warnings.join('')).not.toContain('多谱表乐器合并');
  });

  it('validates additive OMR/rhythm metadata without requiring it in legacy projects', () => {
    const project = createDemoProject();
    expect(validateProject(project)).toEqual([]);
    project.source.kind = 'omr';
    project.source.analysis = {
      transforms: ['none'],
      rhythm: { bpm: 92, offsetSeconds: 0.5, beatTimesSeconds: [0.5, 1.2], method: 'fixture' },
      quality: { reviewed: false },
    };
    expect(validateProject(project)).toEqual([]);
    project.parts[0].staves = [{ number: 1, clef: 'treble' }];
    project.parts[0].notes[0].staff = 2;
    expect(validateProject(project).join('')).toContain('谱表编号');
  });
});

const frozen = 'data/notation-phase2-baseline/bad-status.json';
describe.skipIf(!existsSync(frozen))('Frozen user score regression (private local fixture)', () => {
  it('keeps all 866 notes and all 196 beats while fixing the unusable eight-voice piano staff', () => {
    const project = JSON.parse(readFileSync(frozen, 'utf8')).project as ScoreProject;
    const before = JSON.stringify(project);
    const { result, tune, audio, decoded } = decodeScore(project);
    expect(JSON.stringify(project)).toBe(before);
    expect(result.staffMap).toHaveLength(7);
    expect(result.staffMap!.filter((staff) => staff.partId === 'piano').map((staff) => staff.clef)).toEqual([
      'treble',
      'bass',
    ]);
    expect(result.staffMap!.every((staff) => staff.voiceIds.filter((id) => id !== result.harmonyVoiceId).length <= 2)).toBe(true);
    expect(result.systemMeasures).toHaveLength(25);
    expect(audio.totalDuration * 4).toBe(196);
    expect(tune.warnings ?? []).toEqual([]);
    project.parts.forEach((part) => expect(decoded.get(part.id), part.name).toEqual(fingerprint(part.notes)));
    const restored = fromMusicXml(toMusicXml(project));
    project.parts.forEach((part, index) =>
      expect(fingerprint(restored.parts[index].notes), `${part.name} XML`).toEqual(fingerprint(part.notes)),
    );
  });
});
