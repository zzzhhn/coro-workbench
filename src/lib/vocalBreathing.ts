import type { NoteEvent } from './types';

const EPS = 1e-7;
export const MIN_BREATH_SECONDS = 0.3;

export interface BreathCut {
  startBeat: number;
  resumeBeat: number;
  sourceNoteId: string;
  split: boolean;
}

export interface VocalPhrase {
  first: number;
  last: number;
  start: number;
  end: number;
}

export function vocalPhrases(notes: NoteEvent[], tempo: number): VocalPhrase[] {
  const sounding = notes
    .map((note, index) => ({ note, index }))
    .filter(({ note }) => note.midi !== null && note.velocity > 0)
    .sort((a, b) => a.note.start - b.note.start);
  const minimumGap = (MIN_BREATH_SECONDS * tempo) / 60;
  const result: VocalPhrase[] = [];
  for (const { note, index } of sounding) {
    const previous = result.at(-1);
    if (previous && note.start - previous.end < minimumGap - EPS) {
      previous.last = index;
      previous.end = Math.max(previous.end, note.start + note.duration);
    } else {
      result.push({ first: index, last: index, start: note.start, end: note.start + note.duration });
    }
  }
  return result;
}

/** Shorten a tail or split a sustained vowel; never delete a melodic attack. */
export function planVocalBreaths(
  input: NoteEvent[],
  tempo: number,
  barLength: number,
  maxPhraseSeconds: number,
  newNoteId: () => string,
  minimumSoundSeconds = 0,
) {
  if (![tempo, barLength, maxPhraseSeconds].every((value) => Number.isFinite(value) && value > 0))
    throw new Error('换气规划需要有效速度、小节长度和乐句时长。');
  if (!Number.isFinite(minimumSoundSeconds) || minimumSoundSeconds < 0)
    throw new Error('最短发声时长无效。');
  const notes = input.map((note) => ({ ...note })).sort((a, b) => a.start - b.start);
  const gapBeats =
    [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].find((value) => (value * 60) / tempo >= MIN_BREATH_SECONDS - EPS) ??
    Math.ceil((MIN_BREATH_SECONDS * tempo) / 60);
  const maximumBeats = (maxPhraseSeconds * tempo) / 60;
  const lookback = Math.min(maximumBeats * 0.4, (2.5 * tempo) / 60);
  const minimumNote = Math.max(0.125, minimumSoundSeconds * tempo / 60);
  const cuts: BreathCut[] = [];
  const unresolvedStarts = new Set<number>();
  // Each successful pass adds a real gap; unresolved fast passages are reported, not erased.
  for (let pass = 0; pass <= input.length + 4096; pass++) {
    const phrase = vocalPhrases(notes, tempo).find(
      (item) => item.end - item.start > maximumBeats + EPS && !unresolvedStarts.has(item.start),
    );
    if (!phrase) break;
    const deadline = phrase.start + maximumBeats;
    const candidates: Array<{ index: number; start: number; resume: number; split: boolean; cost: number }> =
      [];
    for (let index = phrase.first; index <= phrase.last; index++) {
      const note = notes[index];
      if (note.midi === null || note.velocity <= 0 || note.start >= deadline) continue;
      const end = note.start + note.duration;
      const next = notes
        .slice(index + 1, phrase.last + 1)
        .find((item) => item.midi !== null && item.velocity > 0);
      const propose = (resume: number, split: boolean) => {
        const start = resume - gapBeats;
        if (
          start < deadline - lookback - EPS ||
          start > deadline + EPS ||
          start < note.start + minimumNote - EPS ||
          start >= end - EPS
        )
          return;
        if (split && (resume >= end - minimumNote + EPS || (next && next.start < resume - EPS))) return;
        if (!split && next && end > next.start + EPS) return;
        const barDistance = Math.abs(resume / barLength - Math.round(resume / barLength)) * barLength;
        candidates.push({
          index,
          start,
          resume,
          split,
          cost: deadline - start + Math.min(barDistance, 1) * 0.25,
        });
      };
      if (next) propose(next.start, false);
      if (end > deadline + gapBeats) {
        const lastBar = Math.floor((deadline + gapBeats) / barLength) * barLength;
        propose(lastBar, true);
        propose(Math.floor((deadline + gapBeats) * 8) / 8, true);
      }
      if (minimumSoundSeconds > 0 && end > deadline) {
        // A backing sustain can end just after the deadline. Move the split
        // earlier so its resumed vowel is not shorter than the singing floor.
        const latestResume = Math.min(deadline + gapBeats, end - minimumNote);
        propose(Math.floor((latestResume + EPS) * 8) / 8, true);
      }
    }
    candidates.sort((a, b) => Number(a.split) - Number(b.split) || a.cost - b.cost || b.start - a.start);
    const chosen = candidates[0];
    if (!chosen) {
      unresolvedStarts.add(phrase.start);
      continue;
    }
    const note = notes[chosen.index];
    const oldEnd = note.start + note.duration;
    cuts.push({
      startBeat: chosen.start,
      resumeBeat: chosen.resume,
      sourceNoteId: note.id,
      split: chosen.split,
    });
    note.duration = chosen.start - note.start;
    note.origin = 'arranged';
    delete note.confidence;
    if (chosen.split) {
      notes.splice(chosen.index + 1, 0, {
        ...note,
        id: newNoteId(),
        start: chosen.resume,
        duration: oldEnd - chosen.resume,
        lyric: undefined,
        dynamic: undefined,
      });
    }
  }
  const phrases = vocalPhrases(notes, tempo);
  return {
    notes,
    cuts,
    gapBeats,
    maxPhraseSeconds,
    longestPhraseSeconds: Math.max(0, ...phrases.map((item) => ((item.end - item.start) * 60) / tempo)),
    unresolvedPhrases: phrases.filter(
      (item) => ((item.end - item.start) * 60) / tempo > maxPhraseSeconds + EPS,
    ),
  };
}
