import type { ArrangementOptions, ChordEvent } from './types';

const EPSILON = 0.00001;

export function planHarmonySlots(chords: ChordEvent[], totalBeats: number, barLength: number, tempo: number, options: ArrangementOptions) {
  if (![totalBeats, barLength, tempo].every((value) => Number.isFinite(value) && value > 0))
    throw new Error('和声节奏参数无效。');
  const essential = [...new Set([0, totalBeats, ...chords.flatMap((chord) => [chord.start, chord.start + chord.duration])]
    .map((beat) => Math.max(0, Math.min(totalBeats, beat))))].sort((a, b) => a - b);
  const boundaries = essential.filter((beat, index) => index === 0 || beat - essential[index - 1] > EPSILON);
  if (!chords.length) return { boundaries, skippedPulseCuts: 0 };
  const grid = options.style === 'choral' || options.difficulty === 'easy' ? barLength : options.style === 'jazz' ? 1 : 2;
  const spacingSeconds = options.difficulty === 'easy' ? .5 : options.style === 'jazz' ? .22 : .35;
  const spacing = spacingSeconds * tempo / 60;
  const pulses: number[] = [];
  let next = 0;
  let skippedPulseCuts = 0;
  // Chord starts/ends are musical input; regular pulse cuts are optional. Do
  // not insert a pulse right beside a change and manufacture a tiny syllable.
  for (let bar = 0; bar * barLength < totalBeats - EPSILON; bar++) {
    for (let within = 0; within < barLength - EPSILON; within += grid) {
      const beat = bar * barLength + within;
      if (beat >= totalBeats - EPSILON) break;
      while (next < boundaries.length && boundaries[next] < beat - EPSILON) next++;
      if (Math.abs((boundaries[next] ?? Infinity) - beat) < EPSILON) continue;
      const before = Math.max(boundaries[next - 1] ?? 0, pulses.at(-1) ?? 0);
      const after = boundaries[next] ?? totalBeats;
      if (beat - before < spacing - EPSILON || after - beat < spacing - EPSILON) skippedPulseCuts++;
      else pulses.push(beat);
    }
  }
  return { boundaries: [...boundaries, ...pulses].sort((a, b) => a - b), skippedPulseCuts };
}

export function harmonyNoteDuration(span: number, tempo: number, options: ArrangementOptions): number {
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(tempo) || tempo <= 0)
    throw new Error('和声时值无效。');
  const gap = options.style === 'choral' || options.difficulty === 'easy' ? 0 : options.style === 'jazz' ? .25 : .5;
  const minimumSeconds = minimumHarmonySeconds(options);
  // A short chord gets its full span, not a forced 32nd left after subtracting
  // an entire release gap. Actual breath planning happens later in seconds.
  return (span - gap) * 60 / tempo >= minimumSeconds - EPSILON ? span - gap : span;
}

export function minimumHarmonySeconds(options: ArrangementOptions): number {
  return options.difficulty === 'easy' ? .25 : options.style === 'jazz' && options.difficulty === 'advanced' ? .12 : .2;
}
