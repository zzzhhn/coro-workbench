import type {
  ArrangementOptions,
  ArrangementReport,
  ChordEvent,
  NoteEvent,
  ScorePart,
  ScoreProject,
} from './types';
import {
  beatsPerBar,
  newId,
  normalizeKey,
  pitchName,
  transposeChordSymbol,
  transposeKey,
  validateProject,
} from './music';
import { MIN_BREATH_SECONDS, planVocalBreaths, vocalPhrases } from './vocalBreathing';

const EPSILON = 0.00001;
const VOICE_COLORS = ['#b35c42', '#6e826e', '#5e8195', '#9a804e'];
const PITCHES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

interface VocalDefinition {
  name: string;
  shortName: string;
  range: [number, number];
  easyRange: [number, number];
  clef: ScorePart['clef'];
}

const ENSEMBLES: Record<ArrangementOptions['preset'], VocalDefinition[]> = {
  satb: [
    { name: 'Soprano · 主旋律', shortName: 'S.', range: [60, 81], easyRange: [60, 77], clef: 'treble' },
    { name: 'Alto · 中声部', shortName: 'A.', range: [55, 74], easyRange: [57, 72], clef: 'treble' },
    { name: 'Tenor · 次中音', shortName: 'T.', range: [48, 67], easyRange: [50, 65], clef: 'bass' },
    { name: 'Bass · 低音', shortName: 'B.', range: [40, 60], easyRange: [43, 59], clef: 'bass' },
  ],
  ssaa: [
    { name: 'Soprano I · 主旋律', shortName: 'S1.', range: [62, 81], easyRange: [62, 77], clef: 'treble' },
    { name: 'Soprano II', shortName: 'S2.', range: [60, 79], easyRange: [60, 76], clef: 'treble' },
    { name: 'Alto I', shortName: 'A1.', range: [55, 74], easyRange: [57, 72], clef: 'treble' },
    { name: 'Alto II · 低声部', shortName: 'A2.', range: [53, 72], easyRange: [55, 69], clef: 'treble' },
  ],
  ttbb: [
    { name: 'Tenor I · 主旋律', shortName: 'T1.', range: [48, 69], easyRange: [50, 67], clef: 'bass' },
    { name: 'Tenor II', shortName: 'T2.', range: [46, 67], easyRange: [48, 65], clef: 'bass' },
    { name: 'Baritone', shortName: 'Bar.', range: [43, 64], easyRange: [45, 62], clef: 'bass' },
    { name: 'Bass · 低音', shortName: 'B.', range: [38, 60], easyRange: [40, 57], clef: 'bass' },
  ],
};

function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}
function median(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 60;
}
function overlaps(note: NoteEvent, start: number, end: number): boolean {
  return note.start < end - EPSILON && note.start + note.duration > start + EPSILON;
}
function clampRegister(midi: number, range: [number, number]): number {
  const candidates = Array.from({ length: 11 }, (_, index) => midi + (index - 5) * 12).filter(
    (pitch) => pitch >= range[0] && pitch <= range[1],
  );
  return (
    candidates.sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi))[0] ??
    Math.max(range[0], Math.min(range[1], midi))
  );
}

export function recommendLeadPart(project: ScoreProject): ScorePart | undefined {
  const candidates = project.parts
    .filter(
      (part) =>
        part.role !== 'percussion' && part.notes.some((note) => note.midi !== null && note.velocity > 0),
    )
    .map((part) => {
      const notes = part.notes
        .filter((note) => note.midi !== null && note.velocity > 0)
        .sort((a, b) => a.start - b.start);
      let coverage = 0;
      let end = 0;
      let noteMass = 0;
      for (const note of notes) {
        const nextEnd = note.start + note.duration;
        coverage += Math.max(0, nextEnd - Math.max(end, note.start));
        noteMass += note.duration;
        end = Math.max(end, nextEnd);
      }
      const roleSource = (part as ScorePart & { roleSource?: 'manual' | 'model' }).roleSource;
      const humanLead =
        part.role === 'lead' &&
        (roleSource === 'manual' || (roleSource !== 'model' && project.source.kind !== 'audio'));
      const pitches = notes.map((note) => note.midi!);
      return {
        part,
        notes,
        coverage,
        span: end - notes[0].start,
        monophony: coverage / noteMass,
        register: median(pitches),
        humanLead,
      };
    });
  if (!candidates.length) return undefined;
  const maxCoverage = Math.max(...candidates.map((candidate) => candidate.coverage));
  const maxSpan = Math.max(...candidates.map((candidate) => candidate.span));
  // Sparse model labels are not musical authority; a user-confirmed role remains so.
  const viable = candidates.filter(
    (candidate) => candidate.humanLead || candidate.coverage >= maxCoverage * 0.25,
  );
  const rank = (candidate: (typeof candidates)[number]): number => {
    const roleWeight = candidate.humanLead
      ? 120
      : candidate.part.role === 'lead'
        ? 6
        : candidate.part.role === 'bass'
          ? -18
          : candidate.part.role === 'harmony'
            ? -5
            : 0;
    const coverage = candidate.coverage / maxCoverage;
    const span = candidate.span / maxSpan;
    const register = Math.max(0, 20 - Math.abs(candidate.register - 69) * 0.6);
    const attacks = Math.min(8, Math.log2(candidate.notes.length + 1) * 2);
    return roleWeight + coverage * 18 + candidate.monophony * 34 + span * 12 + register + attacks;
  };
  return viable.sort((a, b) => rank(b) - rank(a))[0]?.part;
}

function chooseLead(project: ScoreProject, id?: string): ScorePart {
  if (id) {
    const requested = project.parts.find((part) => part.id === id && part.role !== 'percussion');
    if (!requested || !requested.notes.some((note) => note.midi !== null))
      throw new Error('所选主旋律声部不存在或没有有音高的音符。');
    return requested;
  }
  const recommendation = recommendLeadPart(project);
  if (!recommendation) throw new Error('乐谱中没有可用于编配的有音高声部；打击乐不能单独生成旋律。');
  return recommendation;
}

function extractMelody(part: ScorePart): { notes: NoteEvent[]; polyphonic: boolean } {
  const notes = [...part.notes]
    .filter((note) => note.midi !== null)
    .sort((a, b) => a.start - b.start || b.midi! - a.midi!);
  let previousEnd = 0;
  let polyphonic = false;
  notes.forEach((note) => {
    if (note.start < previousEnd - EPSILON) polyphonic = true;
    previousEnd = Math.max(previousEnd, note.start + note.duration);
  });
  if (!polyphonic) return { notes: notes.map((note) => ({ ...note })), polyphonic: false };
  const events = new Map<number, { starts: NoteEvent[]; ends: NoteEvent[] }>();
  notes.forEach((note) => {
    for (const [time, kind] of [
      [note.start, 'starts'],
      [note.start + note.duration, 'ends'],
    ] as const) {
      if (!events.has(time)) events.set(time, { starts: [], ends: [] });
      events.get(time)![kind].push(note);
    }
  });
  const boundaries = [...events.keys()].sort((a, b) => a - b);
  const active = new Map<string, NoteEvent>();
  const result: NoteEvent[] = [];
  let previousSourceId = '';
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    events.get(start)!.ends.forEach((note) => active.delete(note.id));
    events.get(start)!.starts.forEach((note) => active.set(note.id, note));
    const candidates = [...active.values()].sort(
      (a, b) => b.midi! - a.midi! || (b.confidence ?? 0.5) - (a.confidence ?? 0.5),
    );
    if (!candidates.length) {
      previousSourceId = '';
      continue;
    }
    const selected = candidates[0];
    const previous = result.at(-1);
    if (
      previous &&
      previousSourceId === selected.id &&
      Math.abs(previous.start + previous.duration - start) < EPSILON
    )
      previous.duration += end - start;
    else
      result.push({
        ...selected,
        start,
        duration: end - start,
        lyric: start === selected.start ? selected.lyric : undefined,
      });
    previousSourceId = selected.id;
  }
  return { notes: result, polyphonic: true };
}

function pitchHistogram(project: ScoreProject, start: number, end: number): number[] {
  const histogram = Array<number>(12).fill(0);
  for (const part of project.parts) {
    if (part.role === 'percussion') continue;
    for (const note of part.notes) {
      if (note.midi === null || !overlaps(note, start, end)) continue;
      const duration = Math.min(end, note.start + note.duration) - Math.max(start, note.start);
      histogram[pitchClass(note.midi)] +=
        duration * (note.velocity || 0.6) * (part.role === 'bass' ? 1.5 : 1);
    }
  }
  return histogram;
}

export function inferKey(project: ScoreProject): string {
  const histogram = pitchHistogram(project, 0, project.measures * beatsPerBar(project));
  if (!histogram.some(Boolean)) return normalizeKey(project.key);
  let best = { score: -Infinity, root: 0, minor: false };
  const center = (values: number[]) => {
    const mean = values.reduce((a, b) => a + b) / values.length;
    return values.map((value) => value - mean);
  };
  const observed = center(histogram);
  [MAJOR_PROFILE, MINOR_PROFILE].forEach((profile, minor) => {
    const centered = center(profile);
    for (let root = 0; root < 12; root++) {
      const score = observed.reduce(
        (sum, value, pitch) => sum + value * centered[pitchClass(pitch - root)],
        0,
      );
      if (score > best.score) best = { score, root, minor: Boolean(minor) };
    }
  });
  return normalizeKey(PITCHES[best.root] + (best.minor ? 'm' : ''));
}

export function inferChords(project: ScoreProject): ChordEvent[] {
  const barLength = beatsPerBar(project);
  const result: ChordEvent[] = [];
  const templates: Array<{ suffix: string; intervals: number[]; penalty: number }> = [
    { suffix: '', intervals: [0, 4, 7], penalty: 0 },
    { suffix: 'm', intervals: [0, 3, 7], penalty: 0 },
    { suffix: '7', intervals: [0, 4, 7, 10], penalty: 0.2 },
    { suffix: 'maj7', intervals: [0, 4, 7, 11], penalty: 0.25 },
    { suffix: 'm7', intervals: [0, 3, 7, 10], penalty: 0.2 },
    { suffix: 'dim', intervals: [0, 3, 6], penalty: 0.35 },
    { suffix: 'sus4', intervals: [0, 5, 7], penalty: 0.25 },
  ];
  let previousRoot = 0;
  for (let bar = 0; bar < project.measures; bar++) {
    const start = bar * barLength;
    const histogram = pitchHistogram(project, start, start + barLength);
    const mass = histogram.reduce((a, b) => a + b);
    if (mass <= EPSILON) continue;
    const bassNotes = project.parts
      .filter((part) => part.role === 'bass')
      .flatMap((part) => part.notes)
      .filter((note) => note.midi !== null && overlaps(note, start, start + barLength))
      .sort((a, b) => a.start - b.start || a.midi! - b.midi!);
    const bass = bassNotes[0]?.midi;
    const ranked: Array<{
      score: number;
      root: number;
      suffix: string;
      intervals: number[];
      covered: number;
    }> = [];
    templates.forEach((template) => {
      for (let root = 0; root < 12; root++) {
        const pcs = template.intervals.map((interval) => pitchClass(root + interval));
        const covered = pcs.reduce((sum, pc) => sum + histogram[pc], 0) / mass;
        const missing = pcs.filter((pc) => histogram[pc] < mass * 0.025).length;
        const bassMatch = bass !== undefined && bass !== null && pitchClass(bass) === root ? 0.2 : 0;
        const score =
          covered * 2 -
          missing * 0.13 -
          template.penalty * 0.12 +
          bassMatch +
          (root === previousRoot ? 0.025 : 0);
        ranked.push({ score, root, suffix: template.suffix, intervals: template.intervals, covered });
      }
    });
    ranked.sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const certainty = Math.max(
      0.2,
      Math.min(0.89, best.covered * 0.65 + (best.score - ranked[1].score) * 0.5),
    );
    result.push({
      start,
      duration: barLength,
      symbol: PITCHES[best.root] + best.suffix,
      pitches: best.intervals.map((interval) => 48 + best.root + interval),
      confidence: Math.round(certainty * 100) / 100,
    });
    previousRoot = best.root;
  }
  return result;
}

function sourceChordAt(chords: ChordEvent[], start: number, end: number): ChordEvent | undefined {
  return (
    [...chords]
      .reverse()
      .find((chord) => chord.start <= start + EPSILON && chord.start + chord.duration > start + EPSILON) ??
    chords.find((chord) => chord.start < end - EPSILON && chord.start + chord.duration > start + EPSILON)
  );
}

function chordRoot(chord: ChordEvent): number {
  const root = chord.symbol.match(/^([A-G])([#b]?)/);
  const basic: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return root
    ? pitchClass(basic[root[1]] + (root[2] === '#' ? 1 : root[2] === 'b' ? -1 : 0))
    : pitchClass(chord.pitches[0]);
}

function chordBass(chord: ChordEvent): number {
  const slash = chord.symbol.match(/\/([A-G])([#b]?)$/);
  if (!slash) return chordRoot(chord);
  const basic: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return pitchClass(basic[slash[1]] + (slash[2] === '#' ? 1 : slash[2] === 'b' ? -1 : 0));
}

function voiceChord(
  chord: ChordEvent,
  leadFloor: number,
  previous: number[] | undefined,
  ranges: Array<[number, number]>,
  options: ArrangementOptions,
): number[] | null {
  const root = chordRoot(chord);
  const bassRoot = chordBass(chord);
  const pcs = [...new Set(chord.pitches.map(pitchClass))];
  const third = pcs.includes(pitchClass(root + 3))
    ? pitchClass(root + 3)
    : pcs.includes(pitchClass(root + 4))
      ? pitchClass(root + 4)
      : pcs[1];
  const seventh = pcs.find((pc) => [10, 11].includes(pitchClass(pc - root)));
  const allowed =
    options.difficulty === 'easy' && options.style !== 'jazz'
      ? pcs.filter((pc) => ![10, 11].includes(pitchClass(pc - root)))
      : pcs;
  const candidates = ranges.map((range, voiceIndex) =>
    Array.from({ length: range[1] - range[0] + 1 }, (_, index) => range[0] + index).filter(
      (pitch) =>
        allowed.includes(pitchClass(pitch)) &&
        (voiceIndex !== 2 || [bassRoot, root, pitchClass(root + 7)].includes(pitchClass(pitch))),
    ),
  );
  let best: number[] | null = null;
  let bestCost = Infinity;
  for (const alto of candidates[0])
    for (const tenor of candidates[1])
      for (const bass of candidates[2]) {
        if (alto > leadFloor || tenor > alto || bass > tenor) continue;
        if (alto - tenor > (options.preset === 'satb' ? 12 : 10) || tenor - bass > 19) continue;
        const pitches = [alto, tenor, bass];
        const voicedClasses = [...new Set([pitchClass(leadFloor), ...pitches.map(pitchClass)])];
        const centers = ranges.map((range) => (range[0] + range[1]) / 2);
        let cost = pitches.reduce((sum, pitch, index) => sum + Math.abs(pitch - centers[index]) * 0.22, 0);
        if (pitchClass(bass) !== bassRoot) cost += 4.8;
        if (!voicedClasses.includes(third)) cost += 4.5;
        if (seventh !== undefined && options.style === 'jazz' && !voicedClasses.includes(seventh))
          cost += 3.8;
        cost += (4 - voicedClasses.length) * (options.style === 'jazz' ? 1.5 : 0.65);
        if (alto === tenor) cost += 2.8;
        if (tenor === bass) cost += 2.8;
        if (alto === leadFloor) cost += 1.8;
        if (leadFloor - alto > 12) cost += (leadFloor - alto - 12) * 0.4;
        if (previous) {
          const movement = pitches.map((pitch, index) => pitch - previous[index]);
          cost += movement.reduce(
            (sum, delta, index) =>
              sum +
              Math.abs(delta) * (index === 2 ? 0.65 : 0.9) +
              Math.max(0, Math.abs(delta) - (options.difficulty === 'easy' ? 5 : 7)) * 1.8,
            0,
          );
          for (let upper = 0; upper < 3; upper++)
            for (let lower = upper + 1; lower < 3; lower++) {
              const before = pitchClass(previous[upper] - previous[lower]);
              const after = pitchClass(pitches[upper] - pitches[lower]);
              if ([0, 7].includes(before) && before === after && movement[upper] * movement[lower] > 0)
                cost += options.style === 'choral' ? 7 : 2;
            }
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = pitches;
        }
      }
  return best;
}

function fillRests(part: ScorePart, end: number): void {
  const sorted = part.notes.sort((a, b) => a.start - b.start);
  const result: NoteEvent[] = [];
  let cursor = 0;
  for (const note of sorted) {
    if (note.start > cursor + EPSILON)
      result.push({
        id: newId('rest'),
        midi: null,
        start: cursor,
        duration: note.start - cursor,
        velocity: 0,
        origin: 'arranged',
      });
    result.push(note);
    cursor = Math.max(cursor, note.start + note.duration);
  }
  if (cursor < end - EPSILON)
    result.push({
      id: newId('rest'),
      midi: null,
      start: cursor,
      duration: end - cursor,
      velocity: 0,
      origin: 'arranged',
    });
  part.notes = result;
}

function mergeSustains(notes: NoteEvent[]): NoteEvent[] {
  const result: NoteEvent[] = [];
  notes.forEach((note) => {
    const previous = result.at(-1);
    if (
      previous &&
      previous.midi === note.midi &&
      Math.abs(previous.start + previous.duration - note.start) < EPSILON &&
      !note.dynamic
    )
      previous.duration += note.duration;
    else result.push(note);
  });
  return result;
}

export function arrangeForVoices(source: ScoreProject, options: ArrangementOptions): ScoreProject {
  const errors = validateProject(source);
  if (errors.length) throw new Error(errors.join('\n'));
  if (
    !(options.preset in ENSEMBLES) ||
    !['pop', 'choral', 'jazz'].includes(options.style) ||
    !['easy', 'medium', 'advanced'].includes(options.difficulty) ||
    !Number.isInteger(options.transpose) ||
    Math.abs(options.transpose) > 24
  )
    throw new Error('编配选项无效；移调范围为上下 24 个半音。');
  const originalLead = chooseLead(source, options.leadPartId);
  const project = structuredClone(source);
  const barLength = beatsPerBar(project);
  const totalBeats = project.measures * barLength;
  const notes = project.parts.flatMap((part) => part.notes);
  let clipped = 0;
  notes.forEach((note) => {
    if (note.midi !== null) {
      const transposed = note.midi + options.transpose;
      if (transposed < 0 || transposed > 127) clipped++;
      note.midi = Math.max(0, Math.min(127, transposed));
    }
  });
  project.key = transposeKey(project.key, options.transpose);
  project.chords.forEach((chord) => {
    chord.pitches = chord.pitches.map((pitch) => Math.max(0, Math.min(127, pitch + options.transpose)));
    chord.symbol = transposeChordSymbol(chord.symbol, options.transpose);
  });
  const changes: string[] = [];
  const warnings = new Set<string>();
  if (clipped) warnings.add(`${clipped} 个音移调后超出 MIDI 范围，已限制在 0–127；请核对移调设置。`);
  if (source.source.kind === 'audio')
    warnings.add('原始音高、乐器候选和和弦来自自动识别，编配不会验证它们是否正确；请对照原音频复核。');
  const melodySource = project.parts.find((part) => part.id === originalLead.id)!;
  const melody = extractMelody(melodySource);
  if (melody.polyphonic)
    warnings.add('主旋律声部含复音：按最高持续音提取单旋律，并非已确认的人声旋律；请先试听。');
  const definitions = ENSEMBLES[options.preset];
  const inheritedRoleSource = (originalLead as ScorePart & { roleSource?: 'manual' | 'model' }).roleSource;
  const parts: ScorePart[] = definitions.map((definition, index) => ({
    id: `voice-${index + 1}`,
    name: definition.name,
    shortName: definition.shortName,
    instrument: 'choir_aahs',
    role: index === 0 ? 'lead' : index === 3 ? 'bass' : 'harmony',
    ...(index === 0 && inheritedRoleSource ? { roleSource: inheritedRoleSource } : {}),
    clef: definition.clef,
    program: 52,
    color: VOICE_COLORS[index],
    notes: [],
    muted: false,
    solo: false,
    volume: index === 0 ? 0.88 : index === 3 ? 0.74 : 0.62,
    pan: [-0.08, -0.32, 0.3, 0.1][index],
    range: [...(options.difficulty === 'easy' ? definition.easyRange : definition.range)],
  }));
  const leadRange = parts[0].range!;
  const melodyPitches = melody.notes.map((note) => note.midi!);
  const octaveShifts = [-36, -24, -12, 0, 12, 24, 36];
  const scoreOctave = (shift: number) =>
    melody.notes.reduce(
      (sum, note) =>
        sum +
        (Math.max(0, leadRange[0] - note.midi! - shift) + Math.max(0, note.midi! + shift - leadRange[1])) *
          note.duration *
          5,
      0,
    ) +
    Math.abs(shift) * 0.01 +
    Math.abs(median(melodyPitches) + shift - (leadRange[0] + leadRange[1]) / 2) * 0.02;
  const octave = octaveShifts.sort((a, b) => scoreOctave(a) - scoreOctave(b))[0];
  let folded = 0;
  parts[0].notes = melody.notes.map((note) => {
    const intended = note.midi! + octave;
    const midi = clampRegister(intended, leadRange);
    if (midi !== intended) folded++;
    return {
      ...note,
      id: newId('lead'),
      midi,
      velocity: Math.max(0.35, Math.min(0.95, note.velocity)),
      origin: 'arranged',
      lyric: note.lyric || 'da',
    };
  });
  changes.push(`主旋律取自「${originalLead.name}」，以原节奏为基础；换气和音域调整单独列出。`);
  if (octave)
    changes.push(
      `整条主旋律${octave > 0 ? '升高' : '降低'} ${Math.abs(octave) / 12} 个八度，适配 ${options.preset.toUpperCase()}。`,
    );
  if (folded) warnings.add(`${folded} 个主旋律音超出所选音域，已做逐音八度折叠；旋律轮廓有变化，必须复核。`);
  if (options.transpose)
    changes.push(
      `整体${options.transpose > 0 ? '升' : '降'} ${Math.abs(options.transpose)} 个半音，调号改为 ${project.key}。`,
    );
  let inferred = false;
  const preserveHarmonyGaps = project.source.analysis?.quality?.['harmony.preserveGaps'] === true;
  if (!project.chords.length && !preserveHarmonyGaps) {
    project.chords = inferChords(project);
    inferred = true;
    warnings.add('原谱未提供和弦：当前和弦是基于音高时长与低音的规则推断，不是经过人工确认的和声分析。');
    if (source.source.kind === 'audio' && (!source.key || source.key === 'C')) {
      project.key = inferKey(project);
      changes.push(`按音高分布建议调号 ${project.key}，请耳听确认。`);
    }
  }
  if (!project.chords.length) {
    if (!preserveHarmonyGaps) throw new Error('无法从空白乐谱推导和声；请先输入旋律或和弦。');
    warnings.add('和声分析未辨识到和弦：保留主旋律，和声声部留空；没有用旋律重新猜和弦。可在谱面编辑后重新编配。');
  } else if (preserveHarmonyGaps) {
    changes.push('保留和弦的实际起止与无和弦间隙，不将前一个和弦延长覆盖留白。');
  }
  const accompanimentPcs = new Set(project.chords.flatMap((chord) => chord.pitches.map(pitchClass)));
  if (
    accompanimentPcs.size < 3 ||
    (inferred && source.parts.filter((part) => part.role !== 'percussion').length === 1)
  )
    warnings.add('和声证据较少：单旋律不能唯一确定配和弦，当前是一个可编辑的编配方案。');
  const grid =
    options.style === 'choral' || options.difficulty === 'easy'
      ? barLength
      : options.style === 'jazz'
        ? 1
        : 2;
  const boundaries = new Set<number>([0, totalBeats]);
  for (let beat = 0; beat < totalBeats; beat += grid) boundaries.add(beat);
  for (let bar = 0; bar <= project.measures; bar++) boundaries.add(bar * barLength);
  project.chords.forEach((chord) => {
    boundaries.add(Math.max(0, Math.min(totalBeats, chord.start)));
    boundaries.add(Math.max(0, Math.min(totalBeats, chord.start + chord.duration)));
  });
  const slots = [...boundaries].sort((a, b) => a - b);
  let previous: number[] | undefined;
  let unvoiced = 0;
  const harmonyRanges = parts.slice(1).map((part) => part.range!);
  for (let slot = 0; slot < slots.length - 1; slot++) {
    const start = slots[slot];
    const end = slots[slot + 1];
    if (end <= start + EPSILON) continue;
    const chord = sourceChordAt(project.chords, start, end);
    if (!chord) continue;
    const leadNotes = parts[0].notes.filter((note) => overlaps(note, start, end));
    const leadFloor = leadNotes.length
      ? Math.min(...leadNotes.map((note) => note.midi!))
      : median(melodyPitches) + octave;
    const pitches = voiceChord(chord, leadFloor, previous, harmonyRanges, options);
    if (!pitches) {
      unvoiced++;
      continue;
    }
    const isBarStart = Math.abs(start / barLength - Math.round(start / barLength)) < EPSILON;
    const isPhraseEnd = Math.abs(end / (barLength * 4) - Math.round(end / (barLength * 4))) < EPSILON;
    pitches.forEach((midi, index) => {
      const bass = index === 2;
      const sustained = options.style === 'choral' || options.difficulty === 'easy';
      const gap = sustained ? 0 : options.style === 'jazz' ? 0.25 : 0.5;
      const duration = Math.max(0.125, end - start - (isPhraseEnd ? 0.5 : gap));
      if (duration > end - start) return;
      parts[index + 1].notes.push({
        id: newId('harmony'),
        midi,
        start,
        duration,
        velocity: bass ? 0.78 : isBarStart ? 0.66 : 0.58,
        lyric: bass
          ? options.style === 'jazz'
            ? 'dum'
            : 'dm'
          : options.style === 'choral'
            ? 'ah'
            : options.style === 'jazz'
              ? 'doo'
              : 'oo',
        origin: 'arranged',
        ...(start === 0 ? { dynamic: bass ? ('mf' as const) : ('mp' as const) } : {}),
        ...(options.style === 'jazz' && !bass ? { articulation: 'tenuto' as const } : {}),
      });
    });
    previous = pitches;
  }
  if (unvoiced)
    warnings.add(`${unvoiced} 个和声片段无法同时满足音域与声部不交叉，已留白而不是强行生成不可唱的音。`);
  if (options.style === 'choral')
    parts.slice(1).forEach((part) => {
      part.notes = mergeSustains(part.notes);
    });
  const targetPhraseSeconds = options.difficulty === 'easy' ? 8 : options.difficulty === 'advanced' ? 12 : 10;
  const breathing = parts.map((part) => {
    const planned = planVocalBreaths(part.notes, project.tempo, barLength, targetPhraseSeconds, () =>
      newId('breath'),
    );
    part.notes = planned.notes;
    if (planned.cuts.length)
      changes.push(
        `${part.shortName} 按原有间隙与 ${targetPhraseSeconds} 秒乐句目标增加 ${planned.cuts.length} 处换气（每处至少 ${MIN_BREATH_SECONDS} 秒）；只缩短尾音或拆分长音，不删除旋律起音。`,
      );
    if (planned.unresolvedPhrases.length)
      warnings.add(
        `编配时 ${part.shortName} 有 ${planned.unresolvedPhrases.length} 个乐句找不到安全换气位置，未删掉短音强行留白；需人工安排接唱或调整吐字。`,
      );
    return {
      partId: part.id,
      targetSeconds: targetPhraseSeconds,
      minimumBreathSeconds: MIN_BREATH_SECONDS,
      longestPhraseSeconds: planned.longestPhraseSeconds,
      phrasesOverTarget: planned.unresolvedPhrases.length,
      plannedGaps: planned.cuts,
    };
  });
  if (!melody.notes.some((note) => note.lyric))
    changes.push('原谱无歌词：用 da / oo / dm 标注排练音节，没有推测歌曲原词。');
  changes.push(
    `${options.preset.toUpperCase()} 音域约束与不交叉和声；${options.style === 'choral' ? '连贯长音，惩罚平行五八度' : options.style === 'jazz' ? '保留七和弦色彩，每拍 doo / dum' : '流行短句，主旋律优先'}。`,
  );
  if (options.difficulty === 'easy') changes.push('简易级：收窄音域、每小节和声，并优先使用三和弦。');
  if (options.percussion) {
    const percussion: ScorePart = {
      id: 'voice-percussion',
      name: 'Vocal Percussion · 人声打击',
      shortName: 'VP.',
      instrument: 'standard_drum_kit',
      role: 'percussion',
      clef: 'percussion',
      program: 0,
      color: '#887286',
      notes: [],
      muted: false,
      solo: false,
      volume: 0.5,
      pan: 0.03,
    };
    const unit = 4 / project.timeSignature[1];
    const subdivision = options.difficulty === 'advanced' && options.style !== 'choral' ? 0.5 : 1;
    for (let bar = 0; bar < project.measures; bar++) {
      for (let pulse = 0; pulse < project.timeSignature[0]; pulse += subdivision) {
        if (bar === project.measures - 1 && pulse > 0) break;
        const start = bar * barLength + pulse * unit;
        const integer = Number.isInteger(pulse);
        const backbeat = integer && (pulse % 2 === 1 || (project.timeSignature[0] === 3 && pulse === 2));
        const midi = !integer ? 42 : backbeat ? 38 : 36;
        if (options.difficulty === 'easy' && !integer) continue;
        percussion.notes.push({
          id: newId('vp'),
          midi,
          start,
          duration: subdivision * unit,
          velocity: !integer ? 0.43 : backbeat ? 0.66 : 0.73,
          lyric: !integer ? 'ts' : backbeat ? 'pf' : 'B',
          origin: 'arranged',
          articulation: 'staccato',
        });
      }
    }
    parts.push(percussion);
    changes.push('人声打击以 B / pf / ts 标记；试听使用鼓组音色作节奏参考，不是生成真人 beatbox。');
  }
  parts.forEach((part) => fillRests(part, totalBeats));
  project.parts = parts;
  project.id = newId('arrangement');
  project.title = `${source.title.replace(/ · (SATB|SSAA|TTBB)$/, '')} · ${options.preset.toUpperCase()}`;
  project.updatedAt = new Date().toISOString();
  project.createdAt = project.updatedAt;
  project.arrangement = {
    options: { ...options, leadPartId: originalLead.id },
    report: { changes, warnings: [...warnings], ranges: [], breathing },
  };
  const inspection = inspectArrangement(project);
  project.arrangement.report = {
    changes,
    warnings: [...new Set([...warnings, ...inspection.warnings])],
    ranges: inspection.ranges,
    breathing,
  };
  const generatedErrors = validateProject(project);
  if (generatedErrors.length) throw new Error(`编配验证失败：${generatedErrors.join('\n')}`);
  return project;
}

export function inspectArrangement(project: ScoreProject): ArrangementReport {
  const warnings = new Set<string>();
  const parts = project.parts.filter((part) => part.role !== 'percussion');
  const targetSeconds =
    project.arrangement?.options.difficulty === 'easy'
      ? 8
      : project.arrangement?.options.difficulty === 'advanced'
        ? 12
        : 10;
  const breathing: NonNullable<ArrangementReport['breathing']> = [];
  const ranges = parts.map((part) => {
    const notes = part.notes.filter((note) => note.midi !== null);
    const pitches = notes.map((note) => note.midi!);
    const range = part.range;
    const violations = range ? pitches.filter((pitch) => pitch < range[0] || pitch > range[1]).length : 0;
    if (violations)
      warnings.add(
        `${part.shortName} 有 ${violations} 个音超出设定音域 ${pitchName(range![0])}–${pitchName(range![1])}。`,
      );
    let largeLeaps = 0;
    for (let index = 1; index < notes.length; index++) {
      if (Math.abs(notes[index].midi! - notes[index - 1].midi!) > (part.role === 'bass' ? 12 : 9))
        largeLeaps++;
      if (notes[index].start < notes[index - 1].start + notes[index - 1].duration - EPSILON)
        warnings.add(`${part.shortName} 存在重叠音，一个歌手无法同时唱两个音。`);
    }
    if (largeLeaps) warnings.add(`${part.shortName} 有 ${largeLeaps} 次较大跳进，建议排练时复核。`);
    const durations = vocalPhrases(part.notes, project.tempo).map(
      (phrase) => ((phrase.end - phrase.start) * 60) / project.tempo,
    );
    const phrasesOverTarget = durations.filter((seconds) => seconds > targetSeconds + EPSILON).length;
    if (phrasesOverTarget)
      warnings.add(
        `${part.shortName} 有 ${phrasesOverTarget} 个连续乐句超过 ${targetSeconds} 秒；短于 ${MIN_BREATH_SECONDS} 秒的间隙未算作充分换气，请按团员能力复核。`,
      );
    breathing.push({
      partId: part.id,
      longestPhraseSeconds: Math.max(0, ...durations),
      phrasesOverTarget,
      targetSeconds,
      minimumBreathSeconds: MIN_BREATH_SECONDS,
    });
    return {
      partId: part.id,
      low: pitches.length ? Math.min(...pitches) : 0,
      high: pitches.length ? Math.max(...pitches) : 0,
      violations,
    };
  });
  for (let index = 1; index < parts.length; index++) {
    const upper = parts[index - 1];
    const lower = parts[index];
    let crossings = 0;
    for (const note of lower.notes) {
      if (note.midi === null) continue;
      if (
        upper.notes.some(
          (other) =>
            other.midi !== null &&
            overlaps(other, note.start, note.start + note.duration) &&
            other.midi < note.midi!,
        )
      )
        crossings++;
    }
    if (crossings)
      warnings.add(`${upper.shortName} / ${lower.shortName} 有 ${crossings} 处声部交叉，建议调整。`);
  }
  if (parts.some((part) => !part.notes.some((note) => note.midi !== null)))
    warnings.add('至少一个人声声部没有音符，请检查和弦或音域设置。');
  return { warnings: [...warnings], changes: [], ranges, breathing };
}
