import { describe, expect, it } from 'vitest';
import { encodeWav, metronomeGrid, normalizedLoop, sampleBankFor, sampleRequests, waveformPeaks } from '../src/lib/audio';
import { createBlankProject, createDemoProject } from '../src/lib/demo';

describe('playback timing and audio export contracts', () => {
  it('uses real compound meter pulses rather than quarter clicks in 6/8', () => {
    expect(metronomeGrid({ timeSignature: [4, 4] })).toEqual({ step: 1, measure: 4 });
    expect(metronomeGrid({ timeSignature: [6, 8] })).toEqual({ step: 1.5, measure: 3 });
    expect(metronomeGrid({ timeSignature: [9, 8] })).toEqual({ step: 1.5, measure: 4.5 });
    expect(metronomeGrid({ timeSignature: [7, 8] })).toEqual({ step: 0.5, measure: 3.5 });
  });
  it('clips stale loops to current project length', () => {
    const project = createBlankProject();
    project.measures = 1;
    const options = normalizedLoop(project, {
      mode: 'score',
      startBeat: 0,
      loop: true,
      loopStart: 50,
      loopEnd: 60,
      metronome: true,
      countIn: false,
    });
    expect(options.loopEnd).toBe(4);
    expect(options.loopStart).toBeLessThan(4);
    expect(options.loopStart).toBeGreaterThanOrEqual(0);
  });
  it('routes every demo pitched instrument to real bundled samples', () => {
    const project = createDemoProject();
    expect(project.parts.slice(0, 4).map(sampleBankFor)).toEqual([
      'flute',
      'acoustic_grand_piano',
      'cello',
      'acoustic_guitar_nylon',
    ]);
    expect(sampleBankFor({ ...project.parts[0], program: 52, instrument: 'choir_aahs' })).toBe('choir_aahs');
  });
  it('starts playback after decoding only the samples near the start beat', () => {
    const project = createDemoProject();
    const all = sampleRequests(project);
    const piano = project.parts.find((part) => sampleBankFor(part) === 'acoustic_grand_piano')!;
    // A late jump needs far fewer samples than the whole score.
    const late = project.measures * 4 - 4;
    const near = sampleRequests(project, { from: late, to: late + 2 });
    expect(near.length).toBeLessThan(all.length);
    for (const [bank, midi] of near)
      expect(all.some(([b, m]) => b === bank && m === midi)).toBe(true);
    // Notes already sounding at the start beat are included; notes that ended before it are not.
    const held = { ...piano, notes: [{ id: 'held', midi: 30, start: 0, duration: 100, velocity: 0.7 },
      { id: 'gone', midi: 31, start: 0, duration: 1, velocity: 0.7 }] };
    const only = sampleRequests({ ...project, parts: [held] }, { from: 50, to: 52 });
    expect(only).toEqual([['acoustic_grand_piano', 30]]);
  });
  it('writes stereo 16-bit PCM RIFF and clips safely', () => {
    const left = new Float32Array([0, 1, -1, 2]);
    const right = new Float32Array([0.5, -0.5, 0, -2]);
    const buffer = {
      numberOfChannels: 2,
      length: 4,
      sampleRate: 44100,
      getChannelData: (channel: number) => (channel === 0 ? left : right),
    } as AudioBuffer;
    const wav = encodeWav(buffer);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(40, true)).toBe(16);
    expect(wav.length).toBe(60);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32768);
    expect(view.getInt16(56, true)).toBe(32767);
    expect(view.getInt16(58, true)).toBe(-32768);
  });
  it('normalizes waveform peaks from actual samples, keeping silence zero', () => {
    const buffer = {
      getChannelData: () => new Float32Array([0, 0.25, -0.5, 0, 1, 0, 0, 0]),
    } as unknown as AudioBuffer;
    expect(waveformPeaks(buffer, 4)).toEqual([0.25, 0.5, 1, 0]);
    expect(
      waveformPeaks({ getChannelData: () => new Float32Array(20) } as unknown as AudioBuffer, 4),
    ).toEqual([0, 0, 0, 0]);
  });
});
