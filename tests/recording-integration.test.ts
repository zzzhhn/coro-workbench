import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { arrangeForVoices, recommendLeadPart } from '../src/lib/arrange';
import { fromMusicXml, toAbc, toMidi, toMusicXml, validateProject } from '../src/lib/music';
import type { ScoreProject } from '../src/lib/types';

const folder = path.resolve('evidence/recording-runs');
const cases = ['fishin', 'nutcracker', 'trumpet', 'fishin-full'];

describe('actual local transcription outputs integrate with the music engine', () => {
  for (const name of cases) {
    const filename = path.join(folder, `${name}.json`);
    it.skipIf(!existsSync(filename))(
      `${name}: valid editable score, vocal conversion, full-length export`,
      () => {
        const result = JSON.parse(readFileSync(filename, 'utf8'));
        expect(result.status).toBe('complete');
        const project = result.project as ScoreProject;
        expect(validateProject(project)).toEqual([]);
        const before = JSON.stringify(project);
        const abc = toAbc(project);
        const tunes = abcjs.parseOnly(abc.abc);
        expect(tunes).toHaveLength(1);
        expect(tunes[0].warnings ?? []).toEqual([]);
        expect(toMidi(project).slice(0, 4)).toEqual(new Uint8Array([77, 84, 104, 100]));
        const lead = recommendLeadPart(project)!;
        expect(lead.notes.some((note) => note.midi !== null)).toBe(true);
        if (name === 'fishin-full') expect(lead.id).toBe('vocals');
        const arrangement = arrangeForVoices(project, {
          preset: 'satb',
          style: 'pop',
          difficulty: 'medium',
          percussion: true,
          transpose: 0,
        });
        expect(validateProject(arrangement)).toEqual([]);
        expect(arrangement.parts).toHaveLength(5);
        expect(arrangement.measures).toBe(project.measures);
        expect(arrangement.arrangement!.report.ranges.every((range) => range.violations === 0)).toBe(true);
        const xml = toMusicXml(arrangement);
        const restored = fromMusicXml(xml);
        expect(restored.parts).toHaveLength(5);
        expect(restored.measures).toBe(project.measures);
        expect(JSON.stringify(project)).toBe(before);
        expect(arrangement.originalAudio).toEqual(project.originalAudio);
      },
    );
  }
});
