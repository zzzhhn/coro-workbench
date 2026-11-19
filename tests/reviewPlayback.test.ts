import { describe, expect, it } from 'vitest';
import { mappedVersionTime, playbackPosition, playheadX } from '../review/playback';
import type { TimelineSegment } from '../review/playback';

const full = { tempo: 120, measures: 8, timeSignature: [4, 4] as [number, number] };
const short = { ...full, measures: 4 };
const cuts: TimelineSegment[] = [
  { sourceStart: 4, sourceEnd: 12, targetStart: 0 },
  { sourceStart: 18, sourceEnd: 26, targetStart: 8 },
];

describe('review playback', () => {
  it('maps between full and shortened scores in both directions', () => {
    expect(mappedVersionTime(0, full, short, undefined, cuts)).toBe(0);
    expect(mappedVersionTime(5, full, short, undefined, cuts)).toBe(3);
    expect(mappedVersionTime(7, full, short, undefined, cuts)).toBe(4);
    expect(mappedVersionTime(12, full, short, undefined, cuts)).toBe(7);
    expect(mappedVersionTime(15, full, short, undefined, cuts)).toBe(8);
    expect(mappedVersionTime(4, short, full, cuts)).toBe(9);
    expect(mappedVersionTime(7, short, full, cuts)).toBe(12);
    expect(mappedVersionTime(8.7, short, full, cuts)).toBe(13);
    expect(mappedVersionTime(5, full, full)).toBe(5);
  });

  it('reports compound-meter pulses and holds the final bar during the audio tail', () => {
    const jig = { ...full, timeSignature: [6, 8] as [number, number] };
    expect(playbackPosition(.75, jig)).toEqual({ beat: 1.5, bar: 1, pulse: 2 });
    expect(playbackPosition(1.5, jig)).toEqual({ beat: 3, bar: 2, pulse: 1 });
    expect(playbackPosition(13, jig)).toEqual({ beat: 24, bar: 8, pulse: 2 });
  });

  it('keeps a seek rounded by the media clock on its intended bar', () => {
    const score = { ...full, tempo: 65 };
    const downbeat = 16 * 60 / score.tempo;
    expect(playbackPosition(downbeat - .001, score)).toEqual({ beat: 16, bar: 5, pulse: 1 });
    expect(playbackPosition(downbeat - .01, score).bar).toBe(4);
  });

  it('moves through unevenly spaced visual columns and stops at the end barline', () => {
    const anchors = [{ beat: 4, x: 110 }, { beat: 5, x: 140 }, { beat: 8, x: 260 }];
    expect(playheadX(anchors, 4)).toBe(110);
    expect(playheadX(anchors, 5)).toBe(140);
    expect(playheadX(anchors, 6)).toBe(180);
    expect(playheadX(anchors, 8)).toBe(260);
  });
});
