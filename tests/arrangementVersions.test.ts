import { describe, expect, it } from 'vitest';
import { generateArrangementVersion } from '../src/lib/arrangementVersions';
import { createDemoProject } from '../src/lib/demo';
import { validateProject } from '../src/lib/music';
import type { ArrangementOptions } from '../src/lib/types';

const options: ArrangementOptions = { preset: 'solo-satb', style: 'pop', difficulty: 'medium', transpose: 0, percussion: false };

describe('arrangement comparisons', () => {
  it('keeps the complete accepted attack and release and preserves locked silence', () => {
    const source = createDemoProject();
    const { project: approved } = generateArrangementVersion(source, options);
    approved.arrangement!.locks = [{ first: 2, last: 3 }];
    const accepted = { id: 'accepted', start: 3.75, duration: 8.5, midi: 67, velocity: 0.6, lyric: 'Hmm' };
    approved.parts[1].notes = [accepted];
    approved.parts[2].notes = [];
    const before = structuredClone(approved);
    const { project, identical } = generateArrangementVersion(source, options, approved);
    expect(project.parts[1].notes.filter(n => n.start < 12.25 && n.start + n.duration > 3.75)).toEqual([accepted]);
    expect(project.parts[2].notes.filter(n => n.start < 12 && n.start + n.duration > 4)).toEqual([]);
    expect(approved).toEqual(before);
    expect(identical).toBe(false);
    expect(project.arrangement?.revision).toBe(2);
    expect(generateArrangementVersion(source, options, project, approved).identical).toBe(true);
    expect(() => generateArrangementVersion(source, { ...options, transpose: 1 }, approved)).toThrow('锁定');
  });

  it('rejects overlapping lock ranges on import', () => {
    const { project } = generateArrangementVersion(createDemoProject(), options);
    project.arrangement!.locks = [{ first: 1, last: 2 }, { first: 2, last: 3 }];
    expect(validateProject(project).join('')).toContain('锁定小节');
  });
});
