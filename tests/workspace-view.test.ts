import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { arrangeForVoices } from '../src/lib/arrange';
import {
  overlapsUncertainSource,
  partActivity,
  partRange,
  partRoleName,
  rehearsalSections,
} from '../src/components/workspaceView';

describe('workspace presentation preserves musical data', () => {
  it('marks uncertain source intervals with the actual source beat mapping', () => {
    const project = createBlankProject();
    project.originalAudio = {
      name: 'x',
      url: '/api/audio/x/original.wav',
      duration: 60,
      offsetSeconds: -2,
      tempo: 120,
    };
    project.source.analysis = {
      transforms: [],
      uncertaintyIntervals: [{ partId: project.parts[0].id, startSeconds: 3, endSeconds: 4, reason: 'test' }],
    };
    expect(overlapsUncertainSource(project, project.parts[0].id, 10, 1)).toBe(true);
    expect(overlapsUncertainSource(project, project.parts[0].id, 0, 1)).toBe(false);
    expect(overlapsUncertainSource(project, 'another', 10, 1)).toBe(false);
  });
  it('carries only the chosen lead source uncertainty to a derived vocal part', () => {
    const source = createBlankProject();
    source.parts[0].id = 'piano';
    source.parts[0].notes = [{ id: 'melody', midi: 64, start: 0, duration: 4, velocity: 0.8 }];
    source.originalAudio = {
      name: 'fixture.wav',
      url: 'local:fixture',
      duration: 8,
      offsetSeconds: 0,
      tempo: source.tempo,
    };
    source.source.analysis = {
      transforms: [],
      uncertaintyIntervals: [
        { partId: 'piano', startSeconds: 0, endSeconds: 1, reason: 'piano uncertain' },
        { partId: 'vocals', startSeconds: 1, endSeconds: 2, reason: 'unselected vocals uncertain' },
      ],
    };
    const arranged = arrangeForVoices(source, {
      preset: 'satb',
      style: 'pop',
      difficulty: 'medium',
      percussion: false,
      transpose: 0,
      leadPartId: 'piano',
    });
    const beat = source.tempo / 60;
    expect(overlapsUncertainSource(arranged, 'voice-1', 0, beat * 0.5)).toBe(true);
    expect(overlapsUncertainSource(arranged, 'voice-1', beat * 1.2, beat * 0.5)).toBe(false);
    expect(overlapsUncertainSource(arranged, 'voice-2', 0, beat * 0.5)).toBe(false);
  });
  it('shows actual note activity, not a decorative waveform', () => {
    const part = createBlankProject().parts[0];
    part.notes = [
      { id: 'a', midi: 60, start: 0, duration: 2, velocity: 0.8 },
      { id: 'rest', midi: null, start: 2, duration: 2, velocity: 0.8 },
      { id: 'silent', midi: 67, start: 4, duration: 2, velocity: 0 },
      { id: 'b', midi: 65, start: 6, duration: 2, velocity: 0.8 },
    ];
    const before = structuredClone(part);
    expect(partActivity(part, 8, 4)).toEqual([1, 0, 0, 1]);
    expect(part).toEqual(before);
  });
  it('accounts for held notes crossing activity bins', () => {
    const part = createBlankProject().parts[0];
    part.notes = [{ id: 'held', midi: 60, start: 1, duration: 4, velocity: 1 }];
    expect(partActivity(part, 8, 4)).toEqual([0.5, 1, 0.5, 0]);
    expect(partActivity(part, 0, 4)).toEqual([0, 0, 0, 0]);
  });
  it('creates real measure ranges with a clipped final section', () => {
    expect(rehearsalSections(10)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 8 },
      { start: 9, end: 10 },
    ]);
    expect(rehearsalSections(1)).toEqual([{ start: 1, end: 1 }]);
    expect(rehearsalSections(66).at(-1)).toEqual({ start: 65, end: 66 });
  });
  it('reports real voice ranges without assigning a range to an empty part', () => {
    const part = createBlankProject().parts[0];
    expect(partRange(part)).toBeUndefined();
    part.notes = [
      { id: 'a', midi: 48, start: 0, duration: 1, velocity: 1 },
      { id: 'b', midi: 72, start: 1, duration: 1, velocity: 1 },
    ];
    expect(partRange(part)).toEqual([48, 72]);
    expect(partRoleName({ ...part, role: 'bass' })).toBe('低音');
  });
});
