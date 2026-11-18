import { beatsPerBar } from './music';
import type { NoteEvent, ScoreProject } from './types';

type SoundingNote = NoteEvent & { midi: number };

/** Score evidence for a planner. Boundaries are opportunities, not verse/chorus labels. */
export function describeScore(source: ScoreProject, leadId: string) {
  const part = source.parts.find((p) => p.id === leadId);
  if (!part) throw Error('没有选定的主旋律。');
  const notes = part.notes
    .filter((n): n is SoundingNote => n.midi !== null)
    .sort((a, b) => a.start - b.start);
  const bar = beatsPerBar(source);
  const breathGap = Math.max(0.25, (0.3 * source.tempo) / 60);
  const groups: SoundingNote[][] = [];
  let release = -Infinity;
  for (const n of notes) {
    if (!groups.length || n.start - release >= breathGap) groups.push([]);
    groups[groups.length - 1].push(n);
    release = Math.max(release, n.start + n.duration);
  }
  const fingerprints = new Map<string, number[]>();
  const phrases = groups.map((group, index) => {
    const first = group[0];
    const last = group.at(-1)!;
    let low = first.midi,
      high = first.midi,
      end = first.start;
    for (const n of group) {
      low = Math.min(low, n.midi);
      high = Math.max(high, n.midi);
      end = Math.max(end, n.start + n.duration);
    }
    // Only compare full phrases with both movement and at least three attacks.
    if (group.length >= 3 && low !== high) {
      const shape = JSON.stringify(
        group.map((n) => [
          n.midi - first.midi,
          Math.round((n.start - first.start) * 24),
          Math.round(n.duration * 24),
        ]),
      );
      const occurrences = fingerprints.get(shape) ?? [];
      occurrences.push(index + 1);
      fingerprints.set(shape, occurrences);
    }
    return {
      phrase: index + 1,
      firstBar: Math.floor(first.start / bar) + 1,
      lastBar: Math.ceil((end - 1e-6) / bar),
      startBeat: first.start,
      endBeat: end,
      firstPitch: first.midi,
      lastPitch: last.midi,
      low,
      high,
      attacks: group.length,
      lyricAttacks: group.filter((n) => n.lyric?.trim()).length,
    };
  });
  return {
    measures: source.measures,
    meter: source.timeSignature,
    tempo: source.tempo,
    key: source.key,
    sourceParts: source.parts.map((p) => ({ name: p.name, role: p.role })),
    writtenChords: source.chords.map((c) => ({ beat: c.start, symbol: c.symbol })),
    phrases,
    matchingPhrases: [...fingerprints.values()].filter((ids) => ids.length > 1),
    inputWarnings: source.source.warnings,
  };
}
