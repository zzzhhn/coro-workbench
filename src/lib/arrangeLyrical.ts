import { frozenFormPlan } from './auditionPlan';
import { validWrittenSections } from './arrangementEngines';
import { inspectArrangement } from './arrange';
import { arrangeV2, defaultArrangementPlan } from './arrangeV2';
import { projectArrangementNotation } from './midiNotation';
import { beatsPerBar, newId, validateProject } from './music';
import type {
  ArrangementOptions,
  ArrangementSectionPlan,
  ChordEvent,
  NoteEvent,
  ScoreProject,
} from './types';
import { planVocalBreaths, vocalPhrases } from './vocalBreathing';

const EPS = 1e-6;
const VOICES = [
  { name: 'S', low: 62, high: 79, center: 69, volume: 0.62 },
  { name: 'A', low: 55, high: 72, center: 63, volume: 0.57 },
  { name: 'T', low: 50, high: 67, center: 57, volume: 0.62 },
  { name: 'B', low: 40, high: 58, center: 47, volume: 0.68 },
] as const;
const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DYNAMICS = ['p', 'mp', 'mp', 'mf', 'f'] as const;
const pc = (pitch: number) => ((pitch % 12) + 12) % 12;
const endOf = (note: NoteEvent) => note.start + note.duration;
const overlaps = (note: NoteEvent, start: number, end: number) =>
  note.start < end - EPS && endOf(note) > start + EPS;
const enterAfter = (beat: number) => Math.ceil((beat - EPS) * 4) / 4;
const leaveBefore = (beat: number) => Math.floor((beat + EPS) * 4) / 4;

function pitchClass(name?: string) {
  if (!name || !(name[0] in ROOTS)) return undefined;
  const alteration = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
  return pc(ROOTS[name[0]] + alteration);
}

/** Keep the written bass and choose the three upper pitches jointly over each chord. */
function voicing(
  chord: ChordEvent,
  section: ArrangementSectionPlan,
  solo: NoteEvent[],
  previous: number[] | undefined,
  sourceBass: number | undefined,
): number[] {
  const scale = new Set(chord.pitches.map(pc));
  const chordRoot = pitchClass(chord.symbol.match(/^[A-G][#b]?/)?.[0]) ?? pc(chord.pitches[0]);
  const inversion = pitchClass(chord.symbol.match(/\/([A-G][#b]?)$/)?.[1]);
  const bassClass = inversion ?? (sourceBass !== undefined && scale.has(sourceBass) ? sourceBass : chordRoot);
  const definingTone = [3, 4, 2, 5].map((n) => pc(n + chordRoot)).find((n) => scale.has(n));
  const seventh = [10, 11].map((n) => pc(n + chordRoot)).find((n) => scale.has(n));
  const ranges = VOICES.map(({ low, high }, voice) =>
    Array.from({ length: high - low + 1 }, (_, i) => low + i).filter((pitch) =>
      voice === 3 ? pc(pitch) === bassClass : scale.has(pc(pitch)),
    ),
  );
  const activeSolo = solo.filter((note) => overlaps(note, chord.start, chord.start + chord.duration));
  const weight = (pitch: number, i: number) => {
    const center = VOICES[i].center + (i === 0 && section.energy >= 4 ? section.energy - 3 : 0);
    const distance = previous ? Math.abs(previous[i] - pitch) : 0;
    const lowerTenor = i === 2 ? Math.max(0, 54 - pitch) * 0.7 : 0;
    const soloCollision =
      i === 3
        ? 0
        : activeSolo.reduce((cost, note) => {
            const length =
              Math.min(endOf(note), chord.start + chord.duration) - Math.max(note.start, chord.start);
            const difference = Math.abs(note.midi! - pitch);
            if (length < 0.375 || difference > 1) return cost;
            return cost + length * (difference ? 1.25 : 0.22);
          }, 0);
    return (
      Math.abs(pitch - center) * 0.26 +
      distance * 0.28 +
      Math.max(0, distance - (i === 3 ? 7 : 4)) * 0.85 +
      lowerTenor +
      soloCollision
    );
  };
  const costs = ranges.map((range, i) => new Map(range.map((pitch) => [pitch, weight(pitch, i)])));
  let best = { pitches: [] as number[], cost: Infinity };
  for (const s of ranges[0])
    for (const a of ranges[1])
      for (const t of ranges[2])
        for (const b of ranges[3]) {
          if (s < a || a < t || t < b) continue;
          const pitches = [s, a, t, b];
          const classes = new Set(pitches.map(pc));
          const cost =
            pitches.reduce((sum, pitch, i) => sum + costs[i].get(pitch)!, 0) +
            (classes.has(chordRoot) ? 0 : 1.8) +
            (definingTone === undefined || classes.has(definingTone) ? 0 : 4.6) +
            (seventh === undefined || classes.has(seventh) ? 0 : 3.2) +
            (4 - new Set(pitches).size) * 18 +
            Math.max(0, s - a - 12) +
            Math.max(0, a - t - 12);
          if (cost < best.cost) best = { pitches, cost };
        }
  return best.pitches;
}

type Window = { start: number; end: number };

function responseWindows(solo: NoteEvent[], phrases: Window[], sectionEnd: number, bar: number): Window[] {
  const held = solo
    .filter((n) => n.duration >= bar * 0.65)
    .map((n) => ({ start: enterAfter(n.start + 0.35), end: leaveBefore(endOf(n)) }));
  const answers = phrases.map((phrase, i) => ({
    start: enterAfter(phrase.end),
    end: leaveBefore(Math.min(phrases[i + 1]?.start ?? sectionEnd, phrase.end + bar) - 0.25),
  }));
  return [...held, ...answers].filter((w) => w.end - w.start >= 0.5 - EPS).sort((a, b) => a.start - b.start);
}

function windowsForVoice(
  voice: number,
  section: ArrangementSectionPlan,
  from: number,
  to: number,
  phrases: Window[],
  replies: Window[],
  bar: number,
): Window[] {
  if (section.kind === 'intro' || section.kind === 'interlude' || section.kind === 'outro') {
    const enable = [
      section.kind === 'outro' ? from : from + Math.min(bar, (to - from) / 2),
      from + Math.min(bar / 2, (to - from) / 3),
      from,
      from,
    ];
    const end = section.kind === 'outro' && voice < 2 ? to - Math.min(bar, (to - from) / 3) : to;
    return [{ start: enterAfter(enable[voice]), end: leaveBefore(end) }];
  }
  const whole = [{ start: from, end: to }];
  if (voice >= 2) return whole;
  if (section.texture === 'answer' && voice === 0) return replies;
  if (section.texture === 'sparse') {
    if (voice === 0) return section.energy >= 3 ? replies : [];
    if (!phrases.length) return whole;
    return [{ start: enterAfter(Math.min(to, from + bar)), end: to }];
  }
  if (!phrases.length || section.energy >= 5) return whole;
  if (voice === 0) {
    if (section.energy <= 2) return replies;
    // Lower voices establish the floor. The upper sound opens after the
    // singer's consonant and holds a vowel into the next harmony.
    return [{ start: enterAfter(Math.max(from, phrases[0].start) + 0.5), end: to }];
  }
  if (section.energy >= 3) return whole;
  return [{ start: enterAfter(Math.max(from, phrases[0].start) + 0.5), end: to }];
}

function sustainCommonTone(notes: NoteEvent[], next: NoteEvent) {
  const previous = notes.at(-1);
  if (
    previous &&
    previous.midi === next.midi &&
    previous.lyric === next.lyric &&
    !next.dynamic &&
    Math.abs(next.start - endOf(previous)) < EPS
  ) {
    previous.duration = endOf(next) - previous.start;
  } else notes.push(next);
}

/** A wordless Solo + SATB arrangement built from the source form, chords and breaths. */
export function arrangeLyrical(source: ScoreProject, options: ArrangementOptions): ScoreProject {
  const writtenForm = source.source.arrangementSections;
  const supplied = validWrittenSections(writtenForm, source.measures) ? writtenForm : undefined;
  const fallback = defaultArrangementPlan(source);
  const frozen = frozenFormPlan(options, source.measures);
  const form = frozen?.sections ?? supplied ?? fallback.sections;
  const plan = frozen ?? {
    ...fallback,
    planner: supplied?.length ? ('manual' as const) : fallback.planner,
    sections: form,
  };
  // Reuse the standard Solo, transposed chord track and part names. This
  // engine writes its own voicings, including chords the standard voicer skips.
  const project = arrangeV2(source, { ...options, engine: 'lyrical' }, { ...plan, sections: [] });
  project.arrangement!.plan = plan;
  const bar = beatsPerBar(project);
  const solo = project.parts[0].notes;
  const bass =
    source.parts.find((p) => p.role === 'bass' && p.id !== project.arrangement!.options.leadPartId)?.notes ??
    [];
  const phrases = vocalPhrases(solo, project.tempo);
  const parts: NoteEvent[][] = VOICES.map(() => []);
  const chords = project.chords.filter((chord) => chord.pitches.length > 0).sort((a, b) => a.start - b.start);
  const breathing = new Map<string, ReturnType<typeof planVocalBreaths>>();
  let previous: number[] | undefined;
  for (const section of form) {
    const from = (section.startBar - 1) * bar;
    const to = from + section.bars * bar;
    const sectionPhrases = phrases.filter((p) => p.start < to && p.end > from);
    const replies = responseWindows(
      solo.filter((n) => overlaps(n, from, to)),
      sectionPhrases,
      to,
      bar,
    );
    const windows = VOICES.map((_, index) =>
      windowsForVoice(index, section, from, to, sectionPhrases, replies, bar),
    );
    const first = VOICES.map(() => true);
    const sectionChords = chords.filter(
      (chord) => chord.start < to - EPS && chord.start + chord.duration > from + EPS,
    );
    for (const chord of sectionChords) {
      const start = Math.max(chord.start, from);
      const end = Math.min(chord.start + chord.duration, to);
      const bassAnchor = bass.find(
        (n) => n.midi !== null && n.start <= start + 0.125 && endOf(n) > start + EPS,
      );
      const pitches = voicing(
        { ...chord, start, duration: end - start },
        section,
        solo,
        previous,
        bassAnchor?.midi == null ? undefined : pc(bassAnchor.midi + options.transpose),
      );
      if (!pitches.length) continue;
      previous = pitches;
      windows.forEach((voiceWindows, voice) => {
        const syllable = voice === 3 ? 'Dm' : section.energy <= 2 ? 'Hmm' : 'Ooh';
        let previousEnd = start;
        for (const window of voiceWindows) {
          const left = Math.max(start, window.start, previousEnd);
          const right = Math.min(end, window.end);
          if (right - left < 0.375 - EPS) continue;
          previousEnd = right;
          const accentBass = voice === 3 && section.bass !== 'sustain' && right - left >= 1 - EPS;
          const gap = accentBass ? 0.25 : 0;
          const velocity = 0.37 + section.energy * 0.073 - (voice === 1 ? 0.045 : 0);
          sustainCommonTone(parts[voice], {
            id: newId('lyrical-' + VOICES[voice].name),
            midi: pitches[voice],
            start: left,
            duration: right - left - gap,
            velocity,
            lyric: syllable,
            origin: 'arranged',
            ...(first[voice] ? { dynamic: DYNAMICS[section.energy - 1] } : {}),
          });
          first[voice] = false;
        }
      });
    }
  }
  for (const [index, voice] of VOICES.entries()) {
    const part = project.parts[index + 1];
    part.volume = voice.volume;
    part.range = [voice.low, voice.high];
    const breathPlan = planVocalBreaths(
      parts[index],
      project.tempo,
      bar,
      9.25,
      () => newId('lyrical-breath-' + voice.name),
      0.52,
    );
    breathing.set(part.id, breathPlan);
    part.notes = breathPlan.notes;
  }
  project.parts = [project.parts[0], ...projectArrangementNotation(project).parts.slice(1)];
  const report = inspectArrangement(project);
  project.arrangement!.report = {
    ...report,
    changes: [
      '独唱保持源谱，和声沿用源谱和弦及可确认的低音。',
      '低声先立，女高随乐句进入。相邻和弦的共同音延留，背景声部独立安排换气。',
      ...form.map((s) => `${s.label}（${s.startBar}–${s.startBar + s.bars - 1} 小节）`),
    ],
    breathing: report.breathing?.map((item) => {
      const planned = breathing.get(item.partId);
      return planned ? { ...item, targetSeconds: planned.maxPhraseSeconds, plannedGaps: planned.cuts } : item;
    }),
  };
  const errors = validateProject(project);
  if (errors.length) throw new Error(errors.join('；'));
  return project;
}
