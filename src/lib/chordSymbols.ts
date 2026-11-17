// Chord symbols: parse the spellings real scores and the OMR text layer use,
// voice them for playback, and edit the project's chord track in place.
// The OMR text layer (server/omr_text.py) writes MusicXML <harmony> with the
// printed suffix in kind@text ("Maj7", "6", "+", "m7b5"...); fromMusicXml keeps
// that text as the symbol. This module accepts the same vocabulary so an OMR
// chord can be edited without being respelled.
import type { ChordEvent, ScoreProject } from './types';

// Local copy: music.ts imports this module, so it must not import music.ts back.
const beatsPerBar = (project: Pick<ScoreProject, 'timeSignature'>) =>
  (project.timeSignature[0] * 4) / project.timeSignature[1];

const EPS = 1e-6;
const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Suffix spellings -> intervals above the root. Longest match wins. */
const QUALITIES: Array<[RegExp, number[]]> = [
  [/^(maj9|Maj9|M9|Δ9)$/, [0, 4, 7, 11, 14]],
  [/^(maj7|Maj7|MA7|Ma7|M7|Δ7|Δ|△7|△)$/, [0, 4, 7, 11]],
  [/^(m7b5|m7\(b5\)|-7b5|ø|ø7|min7b5)$/, [0, 3, 6, 10]],
  [/^(dim7|°7|o7)$/, [0, 3, 6, 9]],
  [/^(dim|°|o)$/, [0, 3, 6]],
  [/^(aug|\+|\+5|#5)$/, [0, 4, 8]],
  [/^(7#5|7\+|aug7|\+7|7\(#5\))$/, [0, 4, 8, 10]],
  [/^(m9|min9|-9|mi9)$/, [0, 3, 7, 10, 14]],
  [/^(m7|min7|-7|mi7)$/, [0, 3, 7, 10]],
  [/^(m6|min6|-6|mi6)$/, [0, 3, 7, 9]],
  [/^(mMaj7|mM7|m\(maj7\)|-Δ7)$/, [0, 3, 7, 11]],
  [/^(m|min|-|mi)$/, [0, 3, 7]],
  [/^(7sus4|7sus)$/, [0, 5, 7, 10]],
  [/^(sus2)$/, [0, 2, 7]],
  [/^(sus4|sus)$/, [0, 5, 7]],
  [/^(6\/9|69)$/, [0, 4, 7, 9, 14]],
  [/^(13)$/, [0, 4, 7, 10, 14, 21]],
  [/^(11)$/, [0, 4, 7, 10, 14, 17]],
  [/^(9)$/, [0, 4, 7, 10, 14]],
  [/^(7b9|7\(b9\))$/, [0, 4, 7, 10, 13]],
  [/^(7)$/, [0, 4, 7, 10]],
  [/^(6)$/, [0, 4, 7, 9]],
  [/^(add9|add2)$/, [0, 4, 7, 14]],
  [/^(5)$/, [0, 7]],
  [/^(|M|maj|Maj)$/, [0, 4, 7]],
];

/** MusicXML <kind> value for a suffix, so other notation programs read the same chord. */
export function musicXmlKind(suffix: string): string {
  const quality = QUALITIES.find(([pattern]) => pattern.test(suffix));
  const key = (quality?.[1] ?? [0, 4, 7]).join(',');
  const kinds: Record<string, string> = {
    '0,4,7': 'major',
    '0,3,7': 'minor',
    '0,3,6': 'diminished',
    '0,4,8': 'augmented',
    '0,4,7,10': 'dominant',
    '0,4,7,11': 'major-seventh',
    '0,3,7,10': 'minor-seventh',
    '0,3,6,10': 'half-diminished',
    '0,3,6,9': 'diminished-seventh',
    '0,4,8,10': 'augmented-seventh',
    '0,3,7,11': 'major-minor',
    '0,4,7,9': 'major-sixth',
    '0,3,7,9': 'minor-sixth',
    '0,4,7,10,14': 'dominant-ninth',
    '0,4,7,11,14': 'major-ninth',
    '0,3,7,10,14': 'minor-ninth',
    '0,4,7,10,14,17': 'dominant-11th',
    '0,4,7,10,14,21': 'dominant-13th',
    '0,2,7': 'suspended-second',
    '0,5,7': 'suspended-fourth',
    '0,5,7,10': 'suspended-fourth',
    '0,7': 'power',
  };
  return kinds[key] ?? 'major';
}

export interface ParsedChord {
  symbol: string;
  pitches: number[];
  noChord: boolean;
}

/** Unicode accidentals and spaces, as the OMR text layer normalizes them. */
export const cleanChordText = (text: string) =>
  text.normalize('NFKC').replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s+/g, '').trim();

/**
 * Parse a chord symbol. Returns undefined for text that is not a chord (an OMR
 * misread like "B66" stays visible as written so a person can fix it).
 */
export function parseChord(text: string): ParsedChord | undefined {
  const clean = cleanChordText(text);
  if (/^N\.?C\.?$/i.test(clean)) return { symbol: 'N.C.', pitches: [], noChord: true };
  const match = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(clean);
  if (!match) return undefined;
  const [, step, alter, suffix, bassStep, bassAlter] = match;
  const quality = QUALITIES.find(([pattern]) => pattern.test(suffix));
  if (!quality) return undefined;
  const root = 48 + ROOTS[step] + (alter === '#' ? 1 : alter === 'b' ? -1 : 0);
  const pitches = quality[1].map((interval) => root + interval);
  // Same convention as MusicXML import: a slash bass that is not already a chord tone is
  // appended an octave lower (C/E keeps C-E-G; C/Bb adds Bb2).
  if (bassStep) {
    const bassPc = (ROOTS[bassStep] + (bassAlter === '#' ? 1 : bassAlter === 'b' ? -1 : 0) + 12) % 12;
    if (!pitches.some((pitch) => pitch % 12 === bassPc)) pitches.push(36 + bassPc);
  }
  return { symbol: clean, pitches, noChord: false };
}

export interface ChordEdit {
  project: ScoreProject;
  /** Index of the edited chord in the new chord list (undefined after delete). */
  index?: number;
}

const sortChords = (chords: ChordEvent[]) => chords.sort((a, b) => a.start - b.start);

/**
 * Durations follow the next change: Coro's chord track is a sequence of
 * changes, like MusicXML <harmony>. Recompute after any insert/move/delete.
 */
function reflowDurations(project: ScoreProject, chords: ChordEvent[]): ChordEvent[] {
  const total = project.measures * beatsPerBar(project);
  const gaps = project.source.analysis?.quality?.['harmony.preserveGaps'] === true;
  return chords.map((chord, index) => {
    const until = chords[index + 1]?.start ?? total;
    // With explicit N.C. gaps a chord never grows across one; otherwise it holds to the next change.
    const end = gaps ? Math.min(until, chord.start + chord.duration) : until;
    return {
      ...chord,
      duration: Math.max(1 / 960, Math.min(total, Math.max(end, chord.start + 1 / 960)) - chord.start),
    };
  });
}

/**
 * Set the chord at `beat` (replace the change starting there, or insert a new one).
 * Empty text deletes the change (the previous chord then holds on); "N.C." ends
 * the previous chord here, leaving a no-chord gap as MusicXML import does.
 */
export function setChordAt(project: ScoreProject, beat: number, text: string): ChordEdit {
  const clean = cleanChordText(text);
  const existing = project.chords.findIndex((chord) => Math.abs(chord.start - beat) < EPS);
  if (!clean) {
    if (existing < 0) return { project };
    const chords = project.chords.filter((_, index) => index !== existing);
    return {
      project: { ...project, chords: reflowDurations(project, chords), updatedAt: new Date().toISOString() },
    };
  }
  const parsed = parseChord(clean);
  if (parsed?.noChord) {
    const chords = project.chords
      .filter((_, index) => index !== existing)
      .map((chord) =>
        chord.start < beat && chord.start + chord.duration > beat + EPS
          ? { ...chord, duration: beat - chord.start }
          : chord,
      );
    const quality = { ...(project.source.analysis?.quality ?? {}), 'harmony.preserveGaps': true };
    return {
      project: {
        ...project,
        chords,
        source: {
          ...project.source,
          analysis: {
            transforms: project.source.analysis?.transforms ?? [],
            ...project.source.analysis,
            quality,
          },
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  if (!parsed) throw new Error(`“${clean}” 不是可识别的和弦。例：C、Am7、FMaj7、Bb7、C/E、G+、F#ø、N.C.`);
  const nextStart =
    project.chords.find((item) => item.start > beat + EPS)?.start ?? project.measures * beatsPerBar(project);
  const chord: ChordEvent = {
    start: Math.round(beat * 960) / 960,
    duration: Math.max(1 / 960, nextStart - beat),
    symbol: parsed.symbol,
    pitches: parsed.pitches,
  };
  const chords =
    existing >= 0
      ? project.chords.map((item, index) =>
          index === existing ? { ...chord, duration: item.duration } : item,
        )
      : sortChords([...project.chords, chord]);
  const reflowed = reflowDurations(project, chords);
  return {
    project: { ...project, chords: reflowed, updatedAt: new Date().toISOString() },
    index: reflowed.findIndex((item) => Math.abs(item.start - chord.start) < EPS),
  };
}

/** Move a chord change to another beat (e.g. an OMR chord placed on the wrong note). */
export function moveChord(project: ScoreProject, index: number, beat: number): ChordEdit {
  const chord = project.chords[index];
  if (!chord) return { project };
  const target = Math.max(0, Math.round(beat * 960) / 960);
  if (project.chords.some((item, i) => i !== index && Math.abs(item.start - target) < EPS))
    throw new Error('该拍已有和弦；请先删除或改写它。');
  const chords = sortChords(
    project.chords.map((item, i) => (i === index ? { ...item, start: target } : item)),
  );
  const reflowed = reflowDurations(project, chords);
  return {
    project: { ...project, chords: reflowed, updatedAt: new Date().toISOString() },
    index: reflowed.findIndex((item) => Math.abs(item.start - target) < EPS),
  };
}

/** Chord symbols that do not parse (OMR misreads to review), with their bar numbers. */
export function unreadableChords(
  project: ScoreProject,
): Array<{ index: number; symbol: string; measure: number }> {
  const bar = beatsPerBar(project);
  return project.chords.flatMap((chord, index) =>
    parseChord(chord.symbol)
      ? []
      : [{ index, symbol: chord.symbol, measure: Math.floor(chord.start / bar) + 1 }],
  );
}
