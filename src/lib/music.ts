import * as ToneMidi from '@tonejs/midi';
import type { Midi as MidiType } from '@tonejs/midi';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseMidi, writeMidi } from 'midi-file';
import type { AbcRenderResult, ChordEvent, NoteEvent, ScorePart, ScoreProject } from './types';
import { createEngravingPlan } from './engraving';
import { noteGateRatio, notePlaybackLevel } from './dynamics';
import { performanceNotes } from './performance';
import type { MeasureRange } from './scoreWindow';

const Midi = ToneMidi.Midi ?? (ToneMidi as unknown as { default: typeof ToneMidi }).default.Midi;

const EPSILON = 0.00001;
const DIVISIONS = 960;
const PALETTE = ['#b35c42', '#6b8068', '#577e91', '#927448', '#887286', '#697983'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FIFTHS: Record<string, number> = {
  Cb: -7,
  Gb: -6,
  Db: -5,
  Ab: -4,
  Eb: -3,
  Bb: -2,
  F: -1,
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  'F#': 6,
  'C#': 7,
  Abm: -7,
  Ebm: -6,
  Bbm: -5,
  Fm: -4,
  Cm: -3,
  Gm: -2,
  Dm: -1,
  Am: 0,
  Em: 1,
  Bm: 2,
  'F#m': 3,
  'C#m': 4,
  'G#m': 5,
  'D#m': 6,
  'A#m': 7,
};

export const newId = (prefix = 'id'): string =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
export const beatsPerBar = (project: Pick<ScoreProject, 'timeSignature'>): number =>
  (project.timeSignature[0] * 4) / project.timeSignature[1];
export const pitchName = (midi: number): string =>
  `${SHARP_NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`;
const cleanText = (text: string): string => text.replace(/[\r\n\u0000-\u001f]/g, ' ').trim();
const abcText = (text: string): string => cleanText(text).replace(/["\\]/g, '');
const xmlText = (text: string | number): string =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const roundBeat = (beat: number): number => Math.round(beat * DIVISIONS) / DIVISIONS;

// Notation formats sustain a harmony until the next symbol. Explicit N.C.
// changes prevent a real gap from becoming a held chord after export/import.
function harmonyChanges(project: ScoreProject): ChordEvent[] {
  const chords = [...project.chords].sort((a, b) => a.start - b.start);
  const total = project.measures * beatsPerBar(project);
  const changes: ChordEvent[] = [];
  const noChord = (start: number, end: number) => {
    if (end > start + EPSILON)
      changes.push({ start, duration: end - start, symbol: 'N.C.', pitches: [] });
  };
  if (!chords.length) {
    if (project.source.analysis?.quality?.['harmony.preserveGaps'] === true) noChord(0, total);
    return changes;
  }
  noChord(0, chords[0].start);
  let covered = 0;
  chords.forEach((chord, index) => {
    changes.push(chord);
    covered = Math.max(covered, chord.start + chord.duration);
    noChord(covered, chords[index + 1]?.start ?? total);
  });
  return changes;
}

function parseKey(key: string): string | undefined {
  const normalized = key
    .trim()
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/\s*(major|maj|大调)$/i, '')
    .replace(/\s*(minor|min|小调)$/i, 'm')
    .replace(/\s+/g, '');
  const canonical = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return canonical in FIFTHS ? canonical : undefined;
}

export const normalizeKey = (key: string): string => parseKey(key) ?? 'C';

export function transposeKey(key: string, semitones: number): string {
  const normalized = normalizeKey(key);
  const minor = normalized.endsWith('m');
  const root = normalized.replace(/m$/, '');
  let pc = SHARP_NAMES.indexOf(root);
  if (pc < 0) pc = FLAT_NAMES.indexOf(root);
  if (root === 'Cb') pc = 11;
  const names = semitones < 0 || (FIFTHS[normalized] ?? 0) < 0 ? FLAT_NAMES : SHARP_NAMES;
  const result = names[(((pc + semitones) % 12) + 12) % 12] + (minor ? 'm' : '');
  return result in FIFTHS ? result : SHARP_NAMES[(((pc + semitones) % 12) + 12) % 12] + (minor ? 'm' : '');
}

function projectShell(kind: ScoreProject['source']['kind'], title: string): ScoreProject {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: newId('score'),
    title,
    composer: '',
    tempo: 100,
    timeSignature: [4, 4],
    key: 'C',
    measures: 1,
    parts: [],
    chords: [],
    source: { kind, warnings: [] },
    createdAt: now,
    updatedAt: now,
  };
}

export function validateProject(project: ScoreProject): string[] {
  const problems: string[] = [];
  const boundedText = (value: unknown, length = 1000): value is string =>
    typeof value === 'string' && value.length <= length;
  const stringList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length <= 10_000 && value.every((item) => boundedText(item, 20_000));
  const score = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const optionalText = (value: unknown, length = 1000): boolean =>
    value === undefined || boundedText(value, length);
  if (!project || typeof project !== 'object') return ['工程不是有效的对象。'];
  if (project.version !== 1) problems.push('不支持此工程版本。');
  if (!boundedText(project.id) || !project.id || !boundedText(project.title, 10_000))
    problems.push('工程缺少编号或标题。');
  if (!boundedText(project.composer, 10_000)) problems.push('作曲者必须是文字。');
  if (!boundedText(project.key, 40) || !parseKey(project.key))
    problems.push('调号必须是受支持的大小调，例如 C、F#、Bbm。');
  if (!boundedText(project.createdAt) || !boundedText(project.updatedAt)) problems.push('工程时间信息无效。');
  if (!Number.isFinite(project.tempo) || project.tempo < 10 || project.tempo > 500)
    problems.push('速度必须在 10–500 BPM 之间。');
  const meter = project.timeSignature;
  if (
    !Array.isArray(meter) ||
    meter.length !== 2 ||
    !Number.isInteger(meter[0]) ||
    meter[0] < 1 ||
    meter[0] > 32 ||
    ![1, 2, 4, 8, 16, 32].includes(meter[1])
  )
    problems.push('拍号无效。');
  if (!Number.isInteger(project.measures) || project.measures < 1 || project.measures > 2048)
    problems.push('小节数必须在 1–2048 之间。');
  if (!Array.isArray(project.parts) || project.parts.length < 1 || project.parts.length > 32)
    return [...problems, '工程应有 1–32 个声部。'];
  const limit = Array.isArray(meter) && meter[1] ? (project.measures * meter[0] * 4) / meter[1] : Infinity;
  const partIds = new Set<string>();
  let noteCount = 0;
  for (const part of project.parts) {
    if (!part || typeof part !== 'object') {
      problems.push('声部数据无效。');
      continue;
    }
    if (!boundedText(part.id) || !part.id || partIds.has(part.id)) problems.push('声部编号重复或缺失。');
    partIds.add(part.id);
    if (!boundedText(part.name) || !boundedText(part.shortName) || !boundedText(part.instrument))
      problems.push('声部名称或音色无效。');
    if (
      !boundedText(part.color, 100) ||
      !/^(?:#[0-9a-f]{3,8}|[a-z]{1,24}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s+-]+\))$/i.test(part.color)
    )
      problems.push(`${part.name}: 声部颜色无效。`);
    if (!['lead', 'harmony', 'bass', 'percussion', 'instrument'].includes(part.role))
      problems.push(`${part.name}: 声部角色无效。`);
    const roleSource = (part as ScorePart & { roleSource?: 'manual' | 'model' }).roleSource;
    if (roleSource !== undefined && !['manual', 'model'].includes(roleSource))
      problems.push(`${part.name}: 声部角色来源无效。`);
    if (typeof part.muted !== 'boolean' || typeof part.solo !== 'boolean')
      problems.push(`${part.name}: 静音或独奏状态无效。`);
    if (part.pan !== undefined && (!Number.isFinite(part.pan) || part.pan < -1 || part.pan > 1))
      problems.push(`${part.name}: 声像必须在 -1–1 之间。`);
    if (
      part.range !== undefined &&
      (!Array.isArray(part.range) ||
        part.range.length !== 2 ||
        part.range.some((pitch) => !Number.isInteger(pitch) || pitch < 0 || pitch > 127) ||
        part.range[0] > part.range[1])
    )
      problems.push(`${part.name}: 音域无效。`);
    if (!optionalText(part.stemUrl, 10_000)) problems.push(`${part.name}: 分轨地址必须是文字。`);
    if (part.sourceId !== undefined && (typeof part.sourceId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(part.sourceId)))
      problems.push(`${part.name}: 声源编号无效。`);
    if (!Number.isInteger(part.program) || part.program < 0 || part.program > 127)
      problems.push(`${part.name}: GM 音色编号无效。`);
    if (!Number.isFinite(part.volume) || part.volume < 0 || part.volume > 1)
      problems.push(`${part.name}: 音量无效。`);
    if (!['treble', 'bass', 'alto', 'percussion'].includes(part.clef))
      problems.push(`${part.name}: 谱号无效。`);
    if (
      part.staves !== undefined &&
      (!Array.isArray(part.staves) ||
        !part.staves.length ||
        part.staves.length > 16 ||
        part.staves.some(
          (staff) =>
            !staff ||
            !Number.isInteger(staff.number) ||
            staff.number < 1 ||
            staff.number > 16 ||
            !['treble', 'bass', 'alto', 'percussion'].includes(staff.clef),
        ) ||
        new Set(part.staves.map((staff) => staff.number)).size !== part.staves.length)
    )
      problems.push(`${part.name}: 多谱表定义无效。`);
    if (!Array.isArray(part.notes)) {
      problems.push(`${part.name}: 音符列表无效。`);
      continue;
    }
    noteCount += part.notes.length;
    const ids = new Set<string>();
    for (const note of part.notes) {
      if (!note || typeof note !== 'object') {
        problems.push(`${part.name}: 音符数据无效。`);
        break;
      }
      if (!boundedText(note.id) || !note.id || ids.has(note.id)) {
        problems.push(`${part.name}: 音符编号重复或缺失。`);
        break;
      }
      ids.add(note.id);
      if (note.midi !== null && (!Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127)) {
        problems.push(`${part.name}: 音高必须为 MIDI 0–127 或休止符。`);
        break;
      }
      if (
        !Number.isFinite(note.start) ||
        note.start < 0 ||
        !Number.isFinite(note.duration) ||
        note.duration <= 0 ||
        note.duration > 8192 ||
        note.start + note.duration > limit + 0.005
      ) {
        problems.push(`${part.name}: 音符时值、起点或小节边界无效。`);
        break;
      }
      if (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) {
        problems.push(`${part.name}: 音符力度无效。`);
        break;
      }
      if (!optionalText(note.lyric, 10_000)) {
        problems.push(`${part.name}: 歌词必须是文字。`);
        break;
      }
      if (note.confidence !== undefined && !score(note.confidence)) {
        problems.push(`${part.name}: 音符模型分必须在 0–1 之间。`);
        break;
      }
      if (note.origin !== undefined && !['transcribed', 'arranged', 'manual', 'demo'].includes(note.origin)) {
        problems.push(`${part.name}: 音符来源无效。`);
        break;
      }
      if (note.articulation !== undefined && !['staccato', 'accent', 'tenuto'].includes(note.articulation)) {
        problems.push(`${part.name}: 奏法无效。`);
        break;
      }
      if (note.arpeggio !== undefined && typeof note.arpeggio !== 'boolean') problems.push(`${part.name}: 琶音记号无效。`);
      if (
        note.arpeggioOffset !== undefined &&
        (!Number.isFinite(note.arpeggioOffset) || note.arpeggioOffset < 0)
      ) {
        problems.push(`${part.name}: 琶音起音延迟无效。`);
        break;
      }
      if (note.dynamic !== undefined && !['pp', 'p', 'mp', 'mf', 'f', 'ff'].includes(note.dynamic)) {
        problems.push(`${part.name}: 力度记号无效。`);
        break;
      }
      if (note.dynamicScope !== undefined && !['staff', 'voice'].includes(note.dynamicScope)) {
        problems.push(`${part.name}: 力度范围无效。`);
        break;
      }
      if (
        note.staff !== undefined &&
        (!Number.isInteger(note.staff) ||
          note.staff < 1 ||
          note.staff > 16 ||
          (Array.isArray(part.staves) && !part.staves.some((staff) => staff.number === note.staff)))
      ) {
        problems.push(`${part.name}: 音符谱表编号无效。`);
        break;
      }
      if (!optionalText(note.voice, 100)) {
        problems.push(`${part.name}: 原始声部编号无效。`);
        break;
      }
    }
  }
  if (noteCount > 100_000) problems.push('工程超过 100,000 个音符的安全上限。');
  if (!Array.isArray(project.chords)) problems.push('和弦列表无效。');
  else if (
    project.chords.length > 100_000 ||
    project.chords.some(
      (chord) =>
        !chord ||
        !boundedText(chord.symbol) ||
        !Number.isFinite(chord.start) ||
        chord.start < 0 ||
        !Number.isFinite(chord.duration) ||
        chord.duration <= 0 ||
        chord.start + chord.duration > limit + 0.005 ||
        !Array.isArray(chord.pitches) ||
        !chord.pitches.length ||
        chord.pitches.length > 128 ||
        chord.pitches.some((pitch) => !Number.isInteger(pitch) || pitch < 0 || pitch > 127) ||
        (chord.confidence !== undefined && !score(chord.confidence)),
    )
  )
    problems.push('和弦数据无效。');
  if (
    !project.source ||
    !stringList(project.source.warnings) ||
    !['demo', 'audio', 'midi', 'musicxml', 'manual', 'omr'].includes(project.source.kind) ||
    !optionalText(project.source.engine) ||
    !optionalText(project.source.filename)
  )
    problems.push('工程来源信息无效。');
  else if (
    project.source.detectedInstruments !== undefined &&
    (!Array.isArray(project.source.detectedInstruments) ||
      project.source.detectedInstruments.length > 1000 ||
      project.source.detectedInstruments.some(
        (item) =>
          !item || !boundedText(item.name) || !boundedText(item.method, 10_000) || !score(item.confidence),
      ))
  )
    problems.push('乐器候选信息无效。');
  if (project.source?.analysis !== undefined) {
    const analysis = project.source.analysis;
    const rhythm = analysis?.rhythm;
    const timeList = (value: unknown): boolean =>
      value === undefined ||
      (Array.isArray(value) &&
        value.length <= 100_000 &&
        value.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0));
    if (
      !analysis ||
      !stringList(analysis.transforms) ||
      !optionalText(analysis.rawProjectUrl, 10_000) ||
      (rhythm !== undefined &&
        (!rhythm ||
          !Number.isFinite(rhythm.bpm) ||
          rhythm.bpm <= 0 ||
          !Number.isFinite(rhythm.offsetSeconds) ||
          !boundedText(rhythm.method, 10_000) ||
          !timeList(rhythm.beatTimesSeconds) ||
          !timeList(rhythm.downbeatTimesSeconds) ||
          (rhythm.confidence !== undefined && !score(rhythm.confidence)))) ||
      (analysis.quality !== undefined &&
        (!analysis.quality ||
          typeof analysis.quality !== 'object' ||
          Array.isArray(analysis.quality) ||
          Object.values(analysis.quality).some(
            (value) =>
              value !== null &&
              typeof value !== 'boolean' &&
              typeof value !== 'string' &&
              !(typeof value === 'number' && Number.isFinite(value)),
          )))
    )
      problems.push('音频分析来源信息无效。');
  }
  if (project.source?.pages !== undefined && (!Array.isArray(project.source.pages) || project.source.pages.length > 200 || project.source.pages.some(url => typeof url !== 'string' || url.length > 10000))) problems.push('原始谱页引用无效。');
  if (project.source?.analysisStartSeconds !== undefined && (!Number.isFinite(project.source.analysisStartSeconds) || project.source.analysisStartSeconds < 0)) problems.push('分析起点无效。');
  const uncertain = project.source?.analysis?.uncertaintyIntervals;
  if (uncertain !== undefined && (!Array.isArray(uncertain) || uncertain.length > 10000 || uncertain.some(item => !item || typeof item.partId !== 'string' || typeof item.reason !== 'string' || !Number.isFinite(item.startSeconds) || !Number.isFinite(item.endSeconds) || item.startSeconds < 0 || item.endSeconds <= item.startSeconds || item.alternatives !== undefined && (!Array.isArray(item.alternatives) || item.alternatives.some(value => typeof value !== 'string'))))) problems.push('待核对时间区间无效。');
  if (project.originalAudio !== undefined) {
    const audio = project.originalAudio;
    if (
      !audio ||
      !boundedText(audio.name, 10_000) ||
      !boundedText(audio.url, 100_000) ||
      (audio.fileUrl !== undefined && !boundedText(audio.fileUrl, 100_000)) ||
      !Number.isFinite(audio.duration) ||
      audio.duration < 0 ||
      !Number.isFinite(audio.offsetSeconds) ||
      Math.abs(audio.offsetSeconds) > 86400 ||
      (audio.tempo !== undefined && (!Number.isFinite(audio.tempo) || audio.tempo < 10 || audio.tempo > 500))
    )
      problems.push('原始音频元数据无效。');
  }
  if (project.arrangement !== undefined) {
    const arrangement = project.arrangement;
    const options = arrangement?.options;
    const report = arrangement?.report;
    if (
      !options ||
      !['satb', 'ssaa', 'ttbb'].includes(options.preset) ||
      !['pop', 'choral', 'jazz'].includes(options.style) ||
      !['easy', 'medium', 'advanced'].includes(options.difficulty) ||
      typeof options.percussion !== 'boolean' ||
      !Number.isInteger(options.transpose) ||
      Math.abs(options.transpose) > 24 ||
      !optionalText(options.leadPartId)
    )
      problems.push('编配选项无效。');
    if (
      !report ||
      !stringList(report.warnings) ||
      !stringList(report.changes) ||
      !Array.isArray(report.ranges) ||
      report.ranges.length > 32 ||
      report.ranges.some(
        (range) =>
          !range ||
          !boundedText(range.partId) ||
          !Number.isInteger(range.low) ||
          range.low < 0 ||
          !Number.isInteger(range.high) ||
          range.high > 127 ||
          range.low > range.high ||
          !Number.isInteger(range.violations) ||
          range.violations < 0,
      )
    )
      problems.push('编配检查报告无效。');
  }
  return problems;
}

function assertValid(project: ScoreProject): void {
  const errors = validateProject(project);
  if (errors.length) throw new Error(errors.slice(0, 5).join('\n'));
}

interface NoteGroup {
  start: number;
  duration: number;
  notes: NoteEvent[];
}

interface Segment {
  start: number;
  duration: number;
  notes: NoteEvent[];
  tiedFrom: boolean;
  tiedTo: boolean;
  notatedDuration?: number;
  tupletPrefix?: string;
}

function measureSegments(lane: NoteGroup[], start: number, duration: number): Segment[] {
  const end = start + duration;
  const result: Segment[] = [];
  let cursor = start;
  for (const group of lane) {
    if (group.start >= end - EPSILON || group.start + group.duration <= start + EPSILON) continue;
    const begin = Math.max(start, group.start);
    const finish = Math.min(end, group.start + group.duration);
    if (begin > cursor + EPSILON)
      result.push({ start: cursor, duration: begin - cursor, notes: [], tiedFrom: false, tiedTo: false });
    result.push({
      start: begin,
      duration: finish - begin,
      notes: group.notes,
      tiedFrom: group.start < begin - EPSILON,
      tiedTo: group.start + group.duration > finish + EPSILON,
    });
    cursor = finish;
  }
  if (cursor < end - EPSILON)
    result.push({ start: cursor, duration: end - cursor, notes: [], tiedFrom: false, tiedTo: false });
  return result;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
function abcDuration(beats: number): string {
  const numerator = Math.max(1, Math.round(beats * 2 * DIVISIONS));
  const divisor = gcd(numerator, DIVISIONS);
  const top = numerator / divisor;
  const bottom = DIVISIONS / divisor;
  return bottom === 1 ? (top === 1 ? '' : String(top)) : `${top === 1 ? '' : top}/${bottom}`;
}

function spellPitch(midi: number, key: string): { step: string; alter: number; octave: number } {
  const names = (FIFTHS[normalizeKey(key)] ?? 0) < 0 ? FLAT_NAMES : SHARP_NAMES;
  const name = names[midi % 12];
  return {
    step: name.charAt(0),
    alter: name.includes('#') ? 1 : name.includes('b') ? -1 : 0,
    octave: Math.floor(midi / 12) - 1,
  };
}

function keyAccidentals(key: string): Record<string, number> {
  const count = FIFTHS[normalizeKey(key)] ?? 0;
  const result: Record<string, number> = {};
  (count >= 0 ? ['F', 'C', 'G', 'D', 'A', 'E', 'B'] : ['B', 'E', 'A', 'D', 'G', 'C', 'F'])
    .slice(0, Math.abs(count))
    .forEach((step) => {
      result[step] = count >= 0 ? 1 : -1;
    });
  return result;
}

function abcPitch(midi: number, key: string, accidentals: Map<string, number>, startsNote = true): string {
  const { step, alter, octave } = spellPitch(midi, key);
  const position = `${step}${octave}`;
  const implied = accidentals.get(position) ?? keyAccidentals(key)[step] ?? 0;
  const accidental = implied === alter ? '' : alter === 1 ? '^' : alter === -1 ? '_' : '=';
  // A tied continuation's accidental belongs to that held note; it does not
  // establish the accidental for later attacks in the new measure.
  if (startsNote) accidentals.set(position, alter);
  const letter =
    octave >= 5
      ? step.toLowerCase() + "'".repeat(Math.max(0, octave - 5))
      : step + ','.repeat(Math.max(0, 4 - octave));
  return accidental + letter;
}

function drumPitch(midi: number): string {
  const common: Record<number, string> = {
    35: '_F',
    36: 'F',
    37: '^c',
    38: 'c',
    39: '_c',
    40: '=c',
    41: 'G',
    42: 'g',
    43: 'A',
    44: '_g',
    45: 'B',
    46: '^g',
    47: 'd',
    48: 'e',
    49: "c'",
    50: 'f',
    51: 'a',
  };
  if (common[midi]) return common[midi];
  if (midi >= 52 && midi <= 81) {
    const reserved = new Set(Object.values(common));
    const candidates = [
      'C',
      'D',
      'E',
      'F',
      'G',
      'A',
      'B',
      'c',
      'd',
      'e',
      'f',
      'g',
      'a',
      'b',
      "c'",
      "d'",
      "e'",
    ]
      .flatMap((note) => ['', '=', '^', '_'].map((accidental) => accidental + note))
      .filter((name) => !reserved.has(name));
    return candidates[midi - 52];
  }
  const spelling = spellPitch(midi, 'C');
  return (
    (spelling.alter ? '^' : '=') +
    (spelling.octave >= 5
      ? spelling.step.toLowerCase() + "'".repeat(spelling.octave - 4)
      : spelling.step + ','.repeat(5 - spelling.octave))
  );
}

export interface AbcLayoutOptions {
  barsPerSystem?: number;
  staffSep?: number;
  systemSep?: number;
  measureRange?: MeasureRange;
  /** Printed numbering only, for a score containing a leading alignment bar. */
  measureNumberOffset?: number;
}

export function toAbc(
  project: ScoreProject,
  partIds?: string[],
  layout: AbcLayoutOptions = {},
): AbcRenderResult {
  assertValid(project);
  const { start: firstMeasure, end: lastMeasure } = layout.measureRange ?? {
    start: 1,
    end: project.measures,
  };
  if (
    !Number.isInteger(firstMeasure) || !Number.isInteger(lastMeasure) ||
    firstMeasure < 1 || lastMeasure > project.measures || lastMeasure < firstMeasure
  ) throw new Error('谱面小节范围无效。');
  const printedFirstMeasure = firstMeasure + (layout.measureNumberOffset ?? 0);
  if (!Number.isInteger(printedFirstMeasure) || printedFirstMeasure < 1)
    throw new Error('显示小节编号无效。');
  const parts = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  if (!parts.length) throw new Error('请至少选择一个声部。');
  const barLength = beatsPerBar(project);
  const plan = createEngravingPlan(project, partIds, layout.measureRange
    ? { start: (firstMeasure - 1) * barLength, end: lastMeasure * barLength }
    : undefined);
  const noteMap: AbcRenderResult['noteMap'] = {};
  const noteSegments: NonNullable<AbcRenderResult['noteSegments']> = {};
  const displayedHarmony = harmonyChanges(project);
  const chordCounts = new Map<number, number>();
  for (const chord of displayedHarmony) {
    const bar = Math.floor((chord.start + EPSILON) / beatsPerBar(project));
    chordCounts.set(bar, (chordCounts.get(bar) ?? 0) + 1);
  }
  const denseHarmony = [...chordCounts.values()].some((count) => count > 3);
  const requestedBarsPerSystem = Math.max(1, Math.min(16, Math.round(layout.barsPerSystem ?? 4)));
  const barsPerSystem = plan.dense || denseHarmony ? Math.min(requestedBarsPerSystem, 2) : requestedBarsPerSystem;
  const staffSep = Math.max(plan.dense ? 52 : 20, Math.min(200, layout.staffSep ?? 62));
  const systemSep = Math.max(20, Math.min(250, layout.systemSep ?? 52));
  if (![barsPerSystem, staffSep, systemSep].every(Number.isFinite)) throw new Error('谱面布局数值无效。');
  const voices = plan.staves.map((staff) => ({
    ...staff,
    lanes: staff.voices.map((voice) => ({ ...voice, lane: voice.groups })),
  }));
  const harmonyVoiceId = displayedHarmony.length ? 'CoroHarmony' : undefined;
  const staffVoiceIds = (staff: (typeof voices)[number]): string[] => [
    ...staff.lanes.map((lane) => lane.id),
    ...(staff === voices[0] && harmonyVoiceId ? [harmonyVoiceId] : []),
  ];
  const staffExpression = (staff: (typeof voices)[number]): string => {
    const ids = staffVoiceIds(staff);
    return ids.length > 1 ? `( ${ids.join(' ')} )` : ids[0];
  };
  const scoreExpression = parts
    .map((part) => {
      const staves = voices.filter((staff) => staff.part.id === part.id);
      return staves.length > 1 ? `{ ${staves.map(staffExpression).join(' ')} }` : staffExpression(staves[0]);
    })
    .join(' ');
  // abcjs truncates decimal Q values; round the printed mark while playback
  // and exports continue to use the measured project tempo.
  let abc = `X:1\nT:${cleanText(project.title)}\n${project.composer ? `C:${cleanText(project.composer)}\n` : ''}M:${project.timeSignature.join('/')}\nL:1/8\nQ:1/4=${Math.round(project.tempo)}\n%%barnumbers 1\n%%score [ ${scoreExpression} ]\n%%staffsep ${staffSep}\n%%sysstaffsep ${systemSep}\n%%vocalspace 12\n%%stretchlast 1\n`;
  const drumNotes = [
    ...new Set(
      parts
        .filter((part) => part.role === 'percussion')
        .flatMap((part) => part.notes.filter((note) => note.midi !== null).map((note) => note.midi!)),
    ),
  ];
  drumNotes.forEach((midi) => {
    if (midi >= 35 && midi <= 81)
      abc += `%%percmap ${drumPitch(midi)} ${midi}${[42, 44, 46, 49, 51, 52, 55, 57, 59].includes(midi) ? ' x' : ' normal'}\n`;
  });
  voices.forEach(({ clef, name, shortName, lanes }) =>
    lanes.forEach((voice, index) => {
      abc += `V:${voice.id} clef=${clef === 'percussion' ? 'perc' : clef}${voice.stem ? ` stems=${voice.stem}` : ''}${index === 0 ? ` name="${abcText(name)}" snm="${abcText(shortName)}"` : ''}\n`;
    }),
  );
  // Timed invisible spacers carry harmony independently: a mid-note chord
  // label must not split the singer's note into artificial tied fragments.
  if (harmonyVoiceId)
    abc += `V:${harmonyVoiceId} clef=${voices[0].clef === 'percussion' ? 'perc' : voices[0].clef} stems=up\n`;
  abc += `K:${normalizeKey(project.key)}\n`;
  if (firstMeasure > 1 || layout.measureNumberOffset) abc += `%%setbarnb ${printedFirstMeasure}\n`;
  const [meterBeats, meterUnit] = project.timeSignature;
  const beamUnit = meterUnit === 8 && meterBeats >= 6 && meterBeats % 3 === 0 ? 1.5 : 4 / meterUnit;
  const hasPercussion = parts.some((part) => part.role === 'percussion' || part.clef === 'percussion');
  const systemMeasures: number[] = [];
  for (let firstBar = firstMeasure - 1; firstBar < lastMeasure;) {
    const firstSystem = firstBar === firstMeasure - 1;
    const peakAttacks = Math.max(0, ...voices.flatMap(staff => staff.lanes.flatMap(({ lane }) =>
      Array.from({ length: barsPerSystem }, (_, offset) => lane.filter(group =>
        group.start >= (firstBar + offset) * barLength
        && group.start < (firstBar + offset + 1) * barLength).length))));
    const systemBars = peakAttacks > 24 ? 1 : barsPerSystem;
    const systemEnd = Math.min(firstBar + systemBars, lastMeasure);
    systemMeasures.push(firstBar + 1);
    voices.forEach(({ part, clef, lanes }, staffIndex) => {
      lanes.forEach(({ lane, id }, laneIndex) => {
        if (firstSystem || hasPercussion) abc += `V:${id}\n`;
        if (firstSystem) abc += `%%MIDI program ${part.role === 'percussion' ? 128 : part.program}\n`;
        // ABC's active key leaks into following voices unless each staff is restored.
        if (hasPercussion)
          abc += `K:${part.role === 'percussion' || clef === 'percussion' ? 'none' : normalizeKey(project.key)}\n`;
        abc += `[V:${id}] `;
        const lyrics: string[] = [];
        let hasLyrics = false;
        for (let bar = firstBar; bar < systemEnd; bar++) {
          const start = bar * barLength;
          const accidentals = new Map<string, number>();
          let previousBeamGroup = -1;
          for (const segment of groupAbcTuplets(measureSegments(lane, start, barLength)
            .flatMap(splitAbcSegment))) {
            const beamGroup = Math.floor((segment.start - start + EPSILON) / beamUnit);
            // Syncopated runs may never end exactly on a beat. Still separate
            // their beams when the next attack belongs to a new metrical beat.
            if (beamGroup > previousBeamGroup && !abc.endsWith(' ')) abc += ' ';
            previousBeamGroup = beamGroup;
            let prefix = '';
            const first = segment.notes[0];
            const firstAttack = first && Math.abs(first.start - segment.start) < EPSILON;
            if (firstAttack) {
              if (first.dynamic) prefix += `!${first.dynamic}!`;
              if (first.articulation === 'staccato') prefix += '.';
              if (first.articulation === 'accent') prefix += '!accent!';
              if (first.articulation === 'tenuto') prefix += '!tenuto!';
              if (first.arpeggio) prefix += '!arpeggio!';
            }
            // abcjs has no notehead for invisible spacer rests. A tuplet on
            // that spacer crashes TripletElem; its exact fraction needs no
            // visible tuplet bracket and already preserves the voice's clock.
            const otherVoiceSounds = lanes.some((other, index) => index !== laneIndex && other.lane.some(group =>
              group.start < start + barLength - EPSILON && group.start + group.duration > start + EPSILON));
            const emptyVoiceBar = Math.abs(segment.start - start) < EPSILON
              && Math.abs(segment.duration - barLength) < EPSILON;
            // On a keyboard grand staff, a rest in the upper lane while the
            // other lane on the same staff is sounding is implied; drawing it
            // stacks rest glyphs above the staff. Same duration, same audio.
            const grandStaffRestCovered = !first && (part.staves?.length ?? 0) > 1
              && lanes.some((other, index) => index !== laneIndex && other.lane.some(group =>
                group.start < segment.start + segment.duration - EPSILON
                && group.start + group.duration > segment.start + EPSILON));
            const invisibleSpacer = !first && (laneIndex > 0 || (emptyVoiceBar && otherVoiceSounds) || grandStaffRestCovered);
            if (!invisibleSpacer) prefix += segment.tupletPrefix ?? '';
            const duration = abcDuration(invisibleSpacer ? segment.duration : segment.notatedDuration ?? segment.duration);
            const pitches = segment.notes.filter((note) => note.midi !== null);
            const pitchedTokens = pitches.map((note) =>
              part.role === 'percussion'
                ? drumPitch(note.midi!)
                : abcPitch(note.midi!, project.key, accidentals, Math.abs(note.start - segment.start) < EPSILON),
            );
            const continuing = pitches.map(
              (note) => note.start + note.duration > segment.start + segment.duration + EPSILON,
            );
            const allContinue = continuing.length > 0 && continuing.every(Boolean);
            const partial = !allContinue && continuing.some(Boolean);
            const glyphTokens = pitchedTokens.map(
              (pitch, index) => pitch + (partial && continuing[index] ? '-' : ''),
            );
            const core = !pitches.length
              ? `${invisibleSpacer ? 'x' : 'z'}${duration}`
              : pitches.length === 1
                ? `${pitchedTokens[0]}${duration}`
                : `[${glyphTokens.join('')}]${duration}`;
            const token = prefix + core + (allContinue ? '-' : '');
            // A headless spacer cannot anchor a beam either. Rest boundaries
            // separate beam groups without changing any note's measured time.
            if (!pitches.length && !abc.endsWith(' ')) abc += ' ';
            const begin = abc.length;
            let mappedBegin = begin;
            while (mappedBegin > 0 && /[ \t]/.test(abc[mappedBegin - 1])) mappedBegin--;
            abc += token;
            if (first) {
              const segmentInfo = {
                partId: part.id,
                noteIds: (pitches.length ? pitches : segment.notes).map((note) => note.id),
                midiPitches: pitches.map((note) => note.midi!),
                start: segment.start,
                duration: segment.duration,
              };
              for (let char = mappedBegin; char < abc.length; char++) {
                noteMap[char] = { partId: part.id, noteId: first.id };
                noteSegments[char] = segmentInfo;
              }
            }
            if (pitches.length > 1) {
              let position = begin + prefix.length + 1;
              pitchedTokens.forEach((pitch, index) => {
                for (let char = position; char < position + pitch.length; char++)
                  noteMap[char] = { partId: part.id, noteId: pitches[index].id };
                position += glyphTokens[index].length;
              });
            }
            const end = segment.start + segment.duration;
            if (!pitches.length || Math.abs((end - start) / beamUnit - Math.round((end - start) / beamUnit)) < EPSILON) abc += ' ';
            if (pitches.length) {
              const lyric = firstAttack ? first?.lyric : undefined;
              hasLyrics ||= Boolean(lyric);
              lyrics.push(
                lyric
                  ? cleanText(lyric)
                      .replace(/[_*|~\\]/g, '')
                      .replace(/-/g, '\\-')
                      .replace(/\s+/g, '~') || '*'
                  : '*',
              );
            }
          }
          abc += bar === project.measures - 1 ? ' |] ' : ' | ';
          lyrics.push('|');
        }
        abc += '\n';
        if (hasLyrics) abc += `w:${lyrics.join(' ')}\n`;
      });
      if (staffIndex === 0 && harmonyVoiceId) {
        if (firstSystem || hasPercussion) abc += `V:${harmonyVoiceId}\n`;
        if (hasPercussion) abc += `K:${part.role === 'percussion' || clef === 'percussion' ? 'none' : normalizeKey(project.key)}\n`;
        abc += `[V:${harmonyVoiceId}] `;
        for (let bar = firstBar; bar < systemEnd; bar++) {
          const start = bar * barLength, end = start + barLength;
          const changes = displayedHarmony.filter((chord) => chord.start >= start - EPSILON && chord.start < end - EPSILON);
          const times = [...new Set([start, ...changes.map((chord) => chord.start), end])].sort((a, b) => a - b);
          for (let i = 0; i < times.length - 1; i++) {
            const labels = changes.filter((chord) => Math.abs(chord.start - times[i]) < EPSILON);
            abc += labels.map((chord) => `"${abcText(chord.symbol)}"`).join('');
            for (const spacer of splitAbcSegment({ start: times[i], duration: times[i + 1] - times[i], notes: [], tiedFrom: false, tiedTo: false }))
              abc += `x${abcDuration(spacer.duration)} `;
          }
          abc += bar === project.measures - 1 ? '|] ' : '| ';
        }
        abc += '\n';
      }
    });
    firstBar += systemBars;
  }
  return {
    abc,
    noteMap,
    harmonyVoiceId,
    noteSegments,
    systemMeasures,
    staffLayout: plan.staves.map(staff => ({ partId: staff.part.id, auxiliary: staff.auxiliary })),
    staffMap: voices.map((staff) => ({
      partId: staff.part.id,
      staffNumber: staff.number,
      clef: staff.clef,
      voiceIds: staffVoiceIds(staff),
    })),
    warnings: plan.warnings,
  };
}

function notationDuration(duration: number): {
  type: string;
  dots: number;
  actual?: number;
  normal?: number;
} {
  const bases: Array<[number, string]> = [
    [8, 'breve'],
    [4, 'whole'],
    [2, 'half'],
    [1, 'quarter'],
    [0.5, 'eighth'],
    [0.25, '16th'],
    [0.125, '32nd'],
    [0.0625, '64th'],
  ];
  for (const [beats, type] of bases) {
    for (let dots = 0; dots <= 2; dots++)
      if (Math.abs(duration - beats * (2 - 1 / 2 ** dots)) < 0.001) return { type, dots };
    if (Math.abs(duration - (beats * 2) / 3) < 0.001) return { type, dots: 0, actual: 3, normal: 2 };
  }
  const [writtenBeats, type] = bases.reduce((best, item) =>
    Math.abs(item[0] - duration) < Math.abs(best[0] - duration) ? item : best,
  );
  const writtenTicks = Math.round(writtenBeats * DIVISIONS);
  const actualTicks = Math.max(1, Math.round(duration * DIVISIONS));
  const divisor = gcd(writtenTicks, actualTicks);
  return { type, dots: 0, actual: writtenTicks / divisor, normal: actualTicks / divisor };
}

function decomposeDuration(duration: number): number[] {
  const simple = [8, 6, 4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625];
  if (
    simple.some((value) => Math.abs(value - duration) < EPSILON) ||
    [8, 4, 2, 1, 0.5, 0.25, 0.125].some((value) => Math.abs((value * 2) / 3 - duration) < 0.001)
  )
    return [duration];
  const result: number[] = [];
  let remaining = roundBeat(duration);
  while (remaining > 0.0001 && result.length < 128) {
    const next = simple.find((value) => value <= remaining + EPSILON);
    if (!next) {
      result.push(remaining);
      break;
    }
    result.push(next);
    remaining = roundBeat(remaining - next);
  }
  return result;
}

function splitAbcSegment(segment: Segment): Segment[] {
  let start = segment.start;
  const durations = decomposeDuration(segment.duration);
  return durations.map((duration, index) => {
    const value = notationDuration(duration);
    let tupletPrefix: string | undefined;
    let notatedDuration: number | undefined;
    if (value.actual && value.normal && value.actual <= 9 && value.normal <= 9) {
      tupletPrefix = `(${value.actual}:${value.normal}:1`;
      notatedDuration = (duration * value.actual) / value.normal;
    }
    const piece = {
      ...segment,
      start,
      duration,
      tiedFrom: segment.tiedFrom || index > 0,
      tiedTo: segment.tiedTo || index < durations.length - 1,
      tupletPrefix,
      notatedDuration,
    };
    start += duration;
    return piece;
  });
}

function groupAbcTuplets(segments: Segment[]): Segment[] {
  for (let index = 0; index + 2 < segments.length; index++) {
    const group = segments.slice(index, index + 3);
    if (group.every((segment) => segment.tupletPrefix === '(3:2:1'
        && segment.notes.some((note) => note.midi !== null)
        && Math.abs(segment.duration - group[0].duration) < EPSILON)
      && group.slice(1).every((segment, i) =>
        Math.abs(segment.start - group[i].start - group[i].duration) < EPSILON)) {
      group[0].tupletPrefix = '(3:2:3';
      group[1].tupletPrefix = group[2].tupletPrefix = undefined;
      index += 2;
    }
  }
  return segments;
}

function xmlHarmony(chord: ChordEvent, offset: number): string {
  if (chord.symbol === 'N.C.')
    return `<harmony><root><root-step text="">C</root-step></root><kind text="N.C.">none</kind><offset>${Math.round(offset * DIVISIONS)}</offset></harmony>`;
  const match = chord.symbol.match(/^([A-G])([#b]?)(.*)$/);
  if (!match) return '';
  const suffix = match[3].split('/')[0];
  const kind = suffix === 'm7b5'
    ? 'half-diminished'
    : suffix === 'dim7'
      ? 'diminished-seventh'
      : suffix === '6'
        ? 'major-sixth'
        : suffix === 'm6'
          ? 'minor-sixth'
          : suffix === 'aug'
            ? 'augmented'
            : suffix === '9'
              ? 'dominant-ninth'
              : /^m(?!aj).*7/.test(suffix)
    ? 'minor-seventh'
    : /^maj7|^Δ/.test(suffix)
      ? 'major-seventh'
      : /^m(?!aj)/.test(suffix)
        ? 'minor'
        : /dim|°/.test(suffix)
          ? 'diminished'
          : /sus2/.test(suffix)
            ? 'suspended-second'
            : /sus/.test(suffix)
              ? 'suspended-fourth'
              : /7|9|11|13/.test(suffix)
                ? 'dominant'
                : 'major';
  const bass = chord.symbol.match(/\/([A-G])([#b]?)$/);
  return `<harmony><root><root-step>${match[1]}</root-step>${match[2] ? `<root-alter>${match[2] === '#' ? 1 : -1}</root-alter>` : ''}</root><kind text="${xmlText(suffix)}">${kind}</kind>${bass ? `<bass><bass-step>${bass[1]}</bass-step>${bass[2] ? `<bass-alter>${bass[2] === '#' ? 1 : -1}</bass-alter>` : ''}</bass>` : ''}<offset>${Math.round(offset * DIVISIONS)}</offset></harmony>`;
}

function xmlNote(
  segment: Segment,
  note: NoteEvent | undefined,
  part: ScorePart,
  key: string,
  voice: string | number,
  chord: boolean,
  firstPiece: boolean,
  staff?: number,
  hiddenRest = false,
): string {
  const pitched = note?.midi !== null && note?.midi !== undefined;
  const duration = Math.max(1, Math.round(segment.duration * DIVISIONS));
  const value = notationDuration(segment.duration);
  let pitch = '<rest/>';
  if (pitched) {
    const spelling = spellPitch(note!.midi!, key);
    pitch =
      part.role === 'percussion'
        ? `<unpitched><display-step>${[35, 36].includes(note!.midi!) ? 'F' : [37, 38, 40].includes(note!.midi!) ? 'C' : 'G'}</display-step><display-octave>${[35, 36].includes(note!.midi!) ? 4 : 5}</display-octave></unpitched>`
        : `<pitch><step>${spelling.step}</step>${spelling.alter ? `<alter>${spelling.alter}</alter>` : ''}<octave>${spelling.octave}</octave></pitch>`;
  }
  const tiedFrom = Boolean(note && note.start < segment.start - EPSILON);
  const tiedTo = Boolean(note && note.start + note.duration > segment.start + segment.duration + EPSILON);
  const tie = pitched ? `${tiedFrom ? '<tie type="stop"/>' : ''}${tiedTo ? '<tie type="start"/>' : ''}` : '';
  const tiedNotation = pitched
    ? `${tiedFrom ? '<tied type="stop"/>' : ''}${tiedTo ? '<tied type="start"/>' : ''}`
    : '';
  const articulation =
    note?.articulation && firstPiece && !tiedFrom
      ? `<articulations><${note.articulation}/></articulations>`
      : '';
  const arpeggio = note?.arpeggio && firstPiece && !tiedFrom ? '<arpeggiate/>' : '';
  const lyric =
    note?.lyric && firstPiece && !tiedFrom
      ? `<lyric number="1"><syllabic>single</syllabic><text>${xmlText(note.lyric)}</text></lyric>`
      : '';
  const instrument =
    part.role === 'percussion' && pitched ? `<instrument id="${xmlText(part.id)}-D${note!.midi}"/>` : '';
  return `<note${hiddenRest ? ' print-object="no"' : ''}${note ? ` dynamics="${Math.round((note.velocity * 10000) / 90)}"` : ''}>${chord ? '<chord/>' : ''}${pitch}<duration>${duration}</duration>${tie}${instrument}<voice>${xmlText(voice)}</voice><type>${value.type}</type>${'<dot/>'.repeat(value.dots)}${value.actual ? `<time-modification><actual-notes>${value.actual}</actual-notes><normal-notes>${value.normal}</normal-notes></time-modification>` : ''}${part.role === 'percussion' && pitched && [42, 44, 46, 49, 51].includes(note!.midi!) ? '<notehead>x</notehead>' : ''}${staff !== undefined ? `<staff>${staff}</staff>` : ''}${tiedNotation || articulation || arpeggio ? `<notations>${tiedNotation}${articulation}${arpeggio}</notations>` : ''}${lyric}</note>`;
}

export function toMusicXml(project: ScoreProject, partIds?: string[]): string {
  assertValid(project);
  const selected = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  if (!selected.length) throw new Error('请至少选择一个声部。');
  const plan = createEngravingPlan(project, partIds);
  // XML IDs are generated separately: imported/user IDs may contain spaces or punctuation.
  const parts = selected.map((part, index) => ({ ...part, id: `P${index + 1}` }));
  const partList = parts
    .map((part, index) => {
      const drums = [...new Set(part.notes.filter((note) => note.midi !== null).map((note) => note.midi!))];
      const instruments =
        part.role === 'percussion'
          ? drums
              .map(
                (midi) =>
                  `<score-instrument id="${part.id}-D${midi}"><instrument-name>GM percussion ${midi}</instrument-name></score-instrument>`,
              )
              .join('')
          : `<score-instrument id="${part.id}-I1"><instrument-name>${xmlText(part.instrument)}</instrument-name></score-instrument>`;
      const playback =
        part.role === 'percussion'
          ? drums
              .map(
                (midi) =>
                  `<midi-instrument id="${part.id}-D${midi}"><midi-channel>10</midi-channel><midi-unpitched>${midi + 1}</midi-unpitched></midi-instrument>`,
              )
              .join('')
          : `<midi-instrument id="${part.id}-I1"><midi-channel>${(index % 15) + (index % 15 >= 9 ? 2 : 1)}</midi-channel><midi-program>${part.program + 1}</midi-program><volume>${Math.round(part.volume * 100)}</volume><pan>${Math.round((part.pan ?? 0) * 90)}</pan></midi-instrument>`;
      return `<score-part id="${part.id}"><part-name>${xmlText(part.name)}</part-name><part-abbreviation>${xmlText(part.shortName)}</part-abbreviation>${instruments}${playback}</score-part>`;
    })
    .join('');
  const barLength = beatsPerBar(project);
  const fifths = FIFTHS[normalizeKey(project.key)] ?? 0;
  const displayedHarmony = harmonyChanges(project);
  const body = parts
    .map((part, partIndex) => {
      const staves = plan.staves.filter((staff) => staff.part.id === selected[partIndex].id);
      let laneNumber = 0;
      const lanes = staves.flatMap((staff) => {
        // Parallel lanes split from one source voice need distinct XML voices;
        // otherwise same-pitch ties on the same staff can attach to the wrong lane.
        const sourceVoices = new Set(staff.voices.map(voice => voice.sourceVoice));
        const usedVoices = new Set<string>();
        return staff.voices.map((voice, index) => {
          let fallback = ++laneNumber;
          let xmlVoice = voice.sourceVoice;
          if (!xmlVoice || usedVoices.has(xmlVoice)) {
            while (sourceVoices.has(String(fallback)) || usedVoices.has(String(fallback))) fallback++;
            xmlVoice = String(fallback);
          }
          usedVoices.add(xmlVoice);
          return { groups: voice.groups, voice: xmlVoice, staff: staff.number, secondary: index > 0 };
        });
      });
      const measures = Array.from({ length: project.measures }, (_, bar) => {
        const start = bar * barLength;
        const clefs = staves
          .map(
            (staff) =>
              `<clef${staves.length > 1 ? ` number="${staff.number}"` : ''}>${staff.clef === 'bass' ? '<sign>F</sign><line>4</line>' : staff.clef === 'alto' ? '<sign>C</sign><line>3</line>' : staff.clef === 'percussion' ? '<sign>percussion</sign>' : '<sign>G</sign><line>2</line>'}</clef>`,
          )
          .join('');
        const key =
          part.role === 'percussion' || part.clef === 'percussion'
            ? '<key print-object="no"><fifths>0</fifths></key>'
            : `<key><fifths>${fifths}</fifths><mode>${project.key.endsWith('m') ? 'minor' : 'major'}</mode></key>`;
        let content =
          bar === 0
            ? `<attributes><divisions>${DIVISIONS}</divisions>${key}<time><beats>${project.timeSignature[0]}</beats><beat-type>${project.timeSignature[1]}</beat-type></time>${staves.length > 1 ? `<staves>${Math.max(...staves.map((staff) => staff.number))}</staves>` : ''}${clefs}</attributes>`
            : '';
        if (bar === 0 && partIndex === 0)
          content += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${project.tempo}</per-minute></metronome></direction-type><sound tempo="${project.tempo}"/></direction>`;
        if (bar > 0 && bar % (plan.dense ? 2 : 4) === 0) content += '<print new-system="yes"/>';
        if (partIndex === 0)
          content += displayedHarmony
            .filter((chord) => chord.start >= start - EPSILON && chord.start < start + barLength - EPSILON)
            .map((chord) => xmlHarmony(chord, chord.start - start))
            .join('');
        lanes.forEach((lane, voiceIndex) => {
          if (voiceIndex)
            content += `<backup><duration>${Math.round(barLength * DIVISIONS)}</duration></backup>`;
          const voice = lane.voice;
          for (const segment of measureSegments(lane.groups, start, barLength)) {
            const first = segment.notes[0];
            if (first?.dynamic && Math.abs(first.start - segment.start) < EPSILON)
              content += `<direction placement="below"><direction-type><dynamics><${first.dynamic}/></dynamics></direction-type>${first.dynamicScope === 'voice' ? `<voice>${xmlText(voice)}</voice>` : ''}${staves.length > 1 || part.staves ? `<staff>${lane.staff}</staff>` : ''}</direction>`;
            const pieces = decomposeDuration(segment.duration);
            let pieceStart = segment.start;
            pieces.forEach((duration, index) => {
              const piece = {
                ...segment,
                start: pieceStart,
                duration,
                tiedFrom: segment.tiedFrom || index > 0,
                tiedTo: segment.tiedTo || index < pieces.length - 1,
              };
              const notes = segment.notes.length ? segment.notes : [undefined];
              notes.forEach((note, noteIndex) => {
                content += xmlNote(
                  piece,
                  note,
                  part,
                  project.key,
                  voice,
                  noteIndex > 0,
                  index === 0,
                  staves.length > 1 || part.staves ? lane.staff : undefined,
                  !note && lane.secondary,
                );
              });
              pieceStart += duration;
            });
          }
        });
        if (bar === project.measures - 1)
          content += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
        return `<measure number="${bar + 1}">${content}</measure>`;
      }).join('\n');
      return `<part id="${part.id}">\n${measures}\n</part>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0"><work><work-title>${xmlText(project.title)}</work-title></work><movement-title>${xmlText(project.title)}</movement-title><identification><creator type="composer">${xmlText(project.composer)}</creator><encoding><software>Coro</software></encoding></identification><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults><part-list>${partList}</part-list>\n${body}\n</score-partwise>`;
}

type XmlNode = Record<string, unknown>;
const nodeTag = (node: XmlNode): string => Object.keys(node).find((key) => key !== ':@') ?? '';
const kids = (node: XmlNode | undefined): XmlNode[] =>
  node ? ((node[nodeTag(node)] as XmlNode[]) ?? []) : [];
const named = (nodes: XmlNode[], name: string): XmlNode | undefined =>
  nodes.find((node) => nodeTag(node) === name);
const allNamed = (nodes: XmlNode[], name: string): XmlNode[] =>
  nodes.filter((node) => nodeTag(node) === name);
const attrs = (node: XmlNode | undefined): Record<string, string> =>
  (node?.[':@'] as Record<string, string>) ?? {};
const textOf = (node: XmlNode | undefined): string =>
  !node
    ? ''
    : nodeTag(node) === '#text'
      ? String(node['#text'] ?? '')
      : kids(node)
          .map((child) => textOf(child))
          .join('');
const childText = (node: XmlNode | undefined, name: string): string => textOf(named(kids(node), name));
const childNumber = (node: XmlNode | undefined, name: string, fallback: number): number => {
  const raw = childText(node, name);
  return raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : fallback;
};

function keyFromFifths(fifths: number, minor: boolean): string {
  return Object.keys(FIFTHS).find((key) => FIFTHS[key] === fifths && key.endsWith('m') === minor) ?? 'C';
}

function xmlChord(node: XmlNode, start: number, divisions: number): ChordEvent | null {
  const kindNode = named(kids(node), 'kind');
  const kind = textOf(kindNode);
  const onset = Math.max(0, start + childNumber(node, 'offset', 0) / divisions);
  if (kind === 'none') return { start: onset, duration: 4, symbol: 'N.C.', pitches: [] };
  const root = named(kids(node), 'root');
  const step = childText(root, 'root-step');
  if (!SHARP_NAMES.includes(step)) return null;
  const alter = childNumber(root, 'root-alter', 0);
  const pc = (SHARP_NAMES.indexOf(step) + alter + 12) % 12;
  const templates: Record<string, { suffix: string; intervals: number[] }> = {
    major: { suffix: '', intervals: [0, 4, 7] },
    minor: { suffix: 'm', intervals: [0, 3, 7] },
    diminished: { suffix: 'dim', intervals: [0, 3, 6] },
    augmented: { suffix: 'aug', intervals: [0, 4, 8] },
    dominant: { suffix: '7', intervals: [0, 4, 7, 10] },
    'major-seventh': { suffix: 'maj7', intervals: [0, 4, 7, 11] },
    'minor-seventh': { suffix: 'm7', intervals: [0, 3, 7, 10] },
    'half-diminished': { suffix: 'm7b5', intervals: [0, 3, 6, 10] },
    'diminished-seventh': { suffix: 'dim7', intervals: [0, 3, 6, 9] },
    'suspended-second': { suffix: 'sus2', intervals: [0, 2, 7] },
    'suspended-fourth': { suffix: 'sus4', intervals: [0, 5, 7] },
    'major-sixth': { suffix: '6', intervals: [0, 4, 7, 9] },
    'minor-sixth': { suffix: 'm6', intervals: [0, 3, 7, 9] },
    'dominant-ninth': { suffix: '9', intervals: [0, 4, 7, 10, 14] },
  };
  const template = templates[kind] ?? templates.major;
  const bass = named(kids(node), 'bass');
  const bassStep = childText(bass, 'bass-step');
  const bassAlter = childNumber(bass, 'bass-alter', 0);
  const pitches = template.intervals.map((interval) => 48 + pc + interval);
  if (SHARP_NAMES.includes(bassStep)) {
    const bassPc = (SHARP_NAMES.indexOf(bassStep) + bassAlter + 12) % 12;
    if (!pitches.some((pitch) => pitch % 12 === bassPc)) pitches.push(36 + bassPc);
  }
  return {
    start: onset,
    duration: 4,
    symbol: `${step}${alter === 1 ? '#' : alter === -1 ? 'b' : ''}${attrs(kindNode)['@_text'] ?? template.suffix}${bassStep ? `/${bassStep}${bassAlter === 1 ? '#' : bassAlter === -1 ? 'b' : ''}` : ''}`,
    pitches,
  };
}

export function fromMusicXml(xml: string): ScoreProject {
  if (xml.length > 20_000_000) throw new Error('MusicXML 文件超过 20 MB 的安全上限。');
  if (/<!ENTITY/i.test(xml)) throw new Error('不接受含自定义 XML 实体的文件。');
  if (XMLValidator.validate(xml) !== true) throw new Error('MusicXML 语法无效，文件可能不完整。');
  const tree = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
  }).parse(xml) as XmlNode[];
  const root = named(tree, 'score-partwise');
  if (!root) throw new Error('请导入 score-partwise 格式的 MusicXML；压缩 MXL 请先解压。');
  const children = kids(root);
  const project = projectShell(
    'musicxml',
    childText(named(children, 'work'), 'work-title') ||
      textOf(named(children, 'movement-title')) ||
      '导入的乐谱',
  );
  project.source.engine = 'MusicXML 4.0 / concert pitch';
  project.composer = textOf(
    allNamed(kids(named(children, 'identification')), 'creator').find(
      (creator) => attrs(creator)['@_type'] === 'composer',
    ),
  );
  const partDefinitions = allNamed(kids(named(children, 'part-list')), 'score-part');
  const warnings = new Set<string>();
  let tempoFound = false;
  let meterFound = false;
  let keyFound = false;
  let maxEnd = 0;
  for (const [partIndex, partNode] of allNamed(children, 'part').entries()) {
    if (partIndex >= 32) throw new Error('暂不支持超过 32 个声部的乐谱。');
    const originalId = attrs(partNode)['@_id'];
    const definition = partDefinitions.find((item) => attrs(item)['@_id'] === originalId);
    const midiInstrument = named(kids(definition), 'midi-instrument');
    const channel = childNumber(midiInstrument, 'midi-channel', partIndex + 1);
    const percussion = channel === 10 || Boolean(named(kids(midiInstrument), 'midi-unpitched'));
    const part: ScorePart = {
      id: newId('part'),
      name: childText(definition, 'part-name') || `声部 ${partIndex + 1}`,
      shortName: childText(definition, 'part-abbreviation') || `P${partIndex + 1}`,
      instrument:
        childText(named(kids(definition), 'score-instrument'), 'instrument-name') || 'acoustic_grand_piano',
      role: percussion ? 'percussion' : 'instrument',
      clef: percussion ? 'percussion' : 'treble',
      program: Math.max(0, Math.min(127, childNumber(midiInstrument, 'midi-program', 1) - 1)),
      color: PALETTE[partIndex % PALETTE.length],
      notes: [],
      muted: false,
      solo: false,
      volume: Math.max(0, Math.min(1, childNumber(midiInstrument, 'volume', 80) / 100)),
      pan: Math.max(-1, Math.min(1, childNumber(midiInstrument, 'pan', 0) / 90)),
    };
    let divisions = 1;
    let localMeter: [number, number] = [4, 4];
    let measureStart = 0;
    let transpose = 0;
    const pendingDynamics = new Map<string, NoteEvent['dynamic']>();
    const openTies = new Map<string, NoteEvent>();
    for (const measure of allNamed(kids(partNode), 'measure')) {
      let cursor = 0;
      let previousOnset = 0;
      let extent = 0;
      for (const node of kids(measure)) {
        const tag = nodeTag(node);
        if (tag === 'attributes') {
          divisions = childNumber(node, 'divisions', divisions);
          if (divisions <= 0 || divisions > 10_000_000) throw new Error('MusicXML divisions 无效。');
          const time = named(kids(node), 'time');
          if (time) {
            const beatsText = childText(time, 'beats');
            const beats = beatsText.split('+').reduce((sum, item) => sum + Number(item), 0);
            const unit = childNumber(time, 'beat-type', 4);
            if (!(beats > 0) || ![1, 2, 4, 8, 16, 32].includes(unit))
              throw new Error('暂不支持此 MusicXML 拍号。');
            localMeter = [beats, unit];
            if (!meterFound) {
              project.timeSignature = localMeter;
              meterFound = true;
            } else if (project.timeSignature.join('/') !== localMeter.join('/'))
              warnings.add('乐谱包含变拍号；音符绝对拍点已保留，工作台按第一个拍号重新分小节。');
          }
          const transposition = named(kids(node), 'transpose');
          if (transposition) {
            transpose =
              childNumber(transposition, 'chromatic', 0) +
              12 * childNumber(transposition, 'octave-change', 0);
            if (transpose) warnings.add('移调乐器已转换为实音；导出也使用实音总谱。');
          }
          const key = named(kids(node), 'key');
          if (
            key &&
            part.role !== 'percussion' &&
            childText(named(kids(node), 'clef'), 'sign') !== 'percussion'
          ) {
            const keyName = transposeKey(
              keyFromFifths(childNumber(key, 'fifths', 0), childText(key, 'mode') === 'minor'),
              transpose,
            );
            if (!keyFound) {
              project.key = keyName;
              keyFound = true;
            } else if (keyName !== project.key)
              warnings.add('乐谱包含调号变化；音高保留，谱面统一使用第一个调号。');
          }
          const clefs = allNamed(kids(node), 'clef');
          const count = Math.max(
            childNumber(node, 'staves', part.staves?.length ?? 1),
            ...clefs.map((clef) => Number(attrs(clef)['@_number']) || 1),
          );
          if (count > 16) throw new Error('单个乐器超过 16 个谱表，暂不支持。');
          if (count > 1 || part.staves) {
            if (!part.staves)
              part.staves = Array.from({ length: count }, (_, index) => ({
                number: index + 1,
                clef: index === 0 ? part.clef : 'bass',
              }));
            clefs.forEach((clef) => {
              const number = Number(attrs(clef)['@_number']) || 1;
              const sign = childText(clef, 'sign');
              const value =
                sign === 'F'
                  ? 'bass'
                  : sign === 'C'
                    ? 'alto'
                    : sign === 'percussion'
                      ? 'percussion'
                      : 'treble';
              const existing = part.staves!.find((staff) => staff.number === number);
              if (existing) {
                if (measureStart > 0 && existing.clef !== value)
                  warnings.add('乐谱包含谱号变化；音高保留，当前使用每个谱表的初始谱号。');
                else existing.clef = value;
              } else part.staves!.push({ number, clef: value });
            });
            part.clef = part.staves.find((staff) => staff.number === 1)?.clef ?? part.clef;
          } else {
            const sign = childText(clefs[0], 'sign');
            const value =
              sign === 'F' ? 'bass' : sign === 'C' ? 'alto' : sign === 'percussion' ? 'percussion' : 'treble';
            if (sign && measureStart > 0 && part.clef !== value)
              warnings.add('乐谱包含谱号变化；音高保留，当前使用初始谱号。');
            else if (sign) part.clef = value;
          }
          if (part.clef === 'percussion') part.role = 'percussion';
        } else if (tag === 'direction' || tag === 'sound') {
          const sound = tag === 'sound' ? node : named(kids(node), 'sound');
          const metronome = named(kids(named(kids(node), 'direction-type')), 'metronome');
          const beatUnit = childText(metronome, 'beat-unit');
          const unit =
            ({ whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 } as Record<string, number>)[
              beatUnit
            ] ?? 1;
          const dotted = allNamed(kids(metronome), 'beat-unit-dot').length;
          const tempo =
            Number(attrs(sound)['@_tempo']) ||
            childNumber(metronome, 'per-minute', 0) * unit * (2 - 1 / 2 ** dotted);
          if (tempo > 0) {
            if (!tempoFound) {
              project.tempo = tempo;
              tempoFound = true;
            } else if (Math.abs(project.tempo - tempo) > 0.01)
              warnings.add('乐谱包含速度变化；当前播放器使用第一个速度。');
          }
          const dynamics = named(kids(named(kids(node), 'direction-type')), 'dynamics');
          const dynamicTag = dynamics ? nodeTag(kids(dynamics)[0] ?? {}) : '';
          if (['pp', 'p', 'mp', 'mf', 'f', 'ff'].includes(dynamicTag))
            pendingDynamics.set(
              `${childText(node, 'staff') || '1'}:${childText(node, 'voice') || '*'}`,
              dynamicTag as NoteEvent['dynamic'],
            );
          if (named(kids(named(kids(node), 'direction-type')), 'wedge'))
            warnings.add('渐强/渐弱线暂未导入，音符力度保留。');
        } else if (tag === 'backup') cursor -= childNumber(node, 'duration', 0) / divisions;
        else if (tag === 'forward') {
          cursor += childNumber(node, 'duration', 0) / divisions;
          extent = Math.max(extent, cursor);
        } else if (tag === 'harmony' && partIndex === 0) {
          const chord = xmlChord(node, measureStart + cursor, divisions);
          if (chord) {
            if (transpose) {
              chord.pitches = chord.pitches.map((pitch) => pitch + transpose);
              chord.symbol = transposeChordSymbol(chord.symbol, transpose);
            }
            project.chords.push(chord);
          }
        } else if (tag === 'note') {
          if (named(kids(node), 'grace')) {
            warnings.add('装饰性倚音暂未导入；请在原始乐谱中核对。');
            continue;
          }
          const duration = childNumber(node, 'duration', 0) / divisions;
          if (duration <= 0) continue;
          const chord = Boolean(named(kids(node), 'chord'));
          const onset = chord ? previousOnset : cursor;
          if (onset < -EPSILON) throw new Error('MusicXML 声部回退超出小节起点。');
          let midi: number | null = null;
          const pitch = named(kids(node), 'pitch');
          const unpitched = named(kids(node), 'unpitched');
          if (pitch) {
            const step = childText(pitch, 'step');
            const alter = childNumber(pitch, 'alter', 0);
            if (!Number.isInteger(alter)) warnings.add('微分音已四舍五入为十二平均律音高。');
            midi =
              (childNumber(pitch, 'octave', 4) + 1) * 12 +
              SHARP_NAMES.indexOf(step) +
              Math.round(alter) +
              transpose;
          } else if (unpitched) {
            const instrumentId = attrs(named(kids(node), 'instrument'))['@_id'];
            const drumDefinition =
              allNamed(kids(definition), 'midi-instrument').find(
                (item) => attrs(item)['@_id'] === instrumentId,
              ) ?? midiInstrument;
            midi = childNumber(drumDefinition, 'midi-unpitched', 39) - 1;
          }
          const voice = childText(node, 'voice') || '1';
          const staff = childText(node, 'staff') || '1';
          const staffNumber = Number(staff);
          if (!Number.isInteger(staffNumber) || staffNumber < 1 || staffNumber > 16)
            throw new Error('MusicXML 音符的谱表编号无效。');
          if (staffNumber > 1 && !part.staves)
            part.staves = [
              { number: 1, clef: part.clef },
              { number: staffNumber, clef: 'bass' },
            ];
          else if (part.staves && !part.staves.some((item) => item.number === staffNumber))
            part.staves.push({ number: staffNumber, clef: staffNumber === 1 ? part.clef : 'bass' });
          const tieTypes = [
            ...allNamed(kids(node), 'tie'),
            ...allNamed(kids(named(kids(node), 'notations')), 'tied'),
          ].map((tie) => attrs(tie)['@_type']);
          const tiedFrom = tieTypes.includes('stop');
          const tiedTo = tieTypes.includes('start');
          const tieKey = `${voice}:${staff}:${midi}`;
          const existing = openTies.get(tieKey);
          const absoluteStart = roundBeat(measureStart + onset);
          if (
            midi !== null &&
            tiedFrom &&
            existing &&
            Math.abs(existing.start + existing.duration - absoluteStart) < 0.01
          ) {
            existing.duration = roundBeat(existing.duration + duration);
            if (!tiedTo) openTies.delete(tieKey);
          } else {
            const articulations = kids(named(kids(named(kids(node), 'notations')), 'articulations')).map(
              nodeTag,
            );
            const lyricNodes = allNamed(kids(node), 'lyric');
            if (lyricNodes.length > 1) warnings.add('多段歌词仅保留第一段。');
            const lyric = allNamed(kids(lyricNodes[0]), 'text').map(textOf).join('');
            const dynamics = Number(attrs(node)['@_dynamics']);
            const dynamicKey = pendingDynamics.has(`${staff}:${voice}`) ? `${staff}:${voice}` : `${staff}:*`;
            const pendingDynamic = pendingDynamics.get(dynamicKey);
            const note: NoteEvent = {
              id: newId('note'),
              midi,
              start: absoluteStart,
              duration: roundBeat(duration),
              velocity: Math.min(
                1,
                Math.max(
                  0,
                  Number.isFinite(dynamics) && attrs(node)['@_dynamics'] !== undefined
                    ? (dynamics * 90) / 10_000
                    : 0.75,
                ),
              ),
              origin: 'manual',
              staff: staffNumber,
              voice,
              ...(lyric ? { lyric } : {}),
              ...(pendingDynamic ? { dynamic: pendingDynamic, dynamicScope: dynamicKey.endsWith(':*') ? 'staff' as const : 'voice' as const } : {}),
              ...(named(kids(named(kids(node), 'notations')), 'arpeggiate') ? { arpeggio: true } : {}),
              ...(articulations.includes('staccato')
                ? { articulation: 'staccato' as const }
                : articulations.includes('accent')
                  ? { articulation: 'accent' as const }
                  : articulations.includes('tenuto')
                    ? { articulation: 'tenuto' as const }
                    : {}),
            };
            part.notes.push(note);
            pendingDynamics.delete(dynamicKey);
            if (midi !== null && tiedTo) openTies.set(tieKey, note);
            else if (tiedFrom) warnings.add('发现缺少起音的延音线；已按独立音符导入。');
          }
          if (!chord) {
            previousOnset = cursor;
            cursor += duration;
          }
          extent = Math.max(extent, onset + duration, cursor);
        } else if (tag === 'barline' && named(kids(node), 'repeat'))
          warnings.add('反复记号不展开；当前按谱面顺序播放一次。');
      }
      const localBarLength = (localMeter[0] * 4) / localMeter[1];
      const implicit = attrs(measure)['@_implicit'] === 'yes';
      const pickup = implicit && extent > EPSILON && extent < localBarLength - EPSILON;
      if (pickup) warnings.add('弱起小节按绝对拍点导入，工作台从第一个音符开始等长分小节。');
      if (extent > localBarLength + EPSILON)
        warnings.add(
          `${part.name} 第 ${attrs(measure)['@_number'] || '?'} 小节记有 ${roundBeat(extent)} 拍，超过拍号规定的 ${localBarLength} 拍；保留全部音符及原时值，超长音符允许跨入下一小节，后续小节仍按拍号对齐。请对照原谱校正。`,
        );
      // A malformed OMR measure must not shift every later event in this part.
      // Its overhang remains audible, including beyond the last nominal bar.
      maxEnd = Math.max(maxEnd, measureStart + extent);
      measureStart += pickup ? extent : localBarLength;
      maxEnd = Math.max(maxEnd, measureStart);
    }
    part.notes.sort((a, b) => a.start - b.start || (b.midi ?? -1) - (a.midi ?? -1));
    if (part.role !== 'percussion' && part.clef === 'bass') part.role = 'bass';
    project.parts.push(part);
  }
  if (!project.parts.length) throw new Error('MusicXML 没有可读取的声部。');
  project.measures = Math.max(1, Math.ceil((maxEnd - EPSILON) / beatsPerBar(project)));
  project.chords.sort((a, b) => a.start - b.start);
  project.chords.forEach((chord, index) => {
    chord.duration = Math.max(
      1 / DIVISIONS,
      (project.chords[index + 1]?.start ?? project.measures * beatsPerBar(project)) - chord.start,
    );
  });
  if (project.chords.some((chord) => chord.symbol === 'N.C.')) {
    project.chords = project.chords.filter((chord) => chord.symbol !== 'N.C.');
    project.source.analysis = { transforms: ['保留 MusicXML 中的 N.C. 无和弦区间。'], quality: { 'harmony.preserveGaps': true } };
  }
  project.source.warnings = [...warnings];
  assertValid(project);
  return project;
}

export function transposeChordSymbol(symbol: string, semitones: number): string {
  return symbol.replace(
    /(^|\/)([A-G])([#b]?)/g,
    (_match, prefix: string, step: string, accidental: string) =>
      `${prefix}${transposeKey(step + accidental, semitones)}`,
  );
}

function encodeMidiText(text: string): string {
  return Array.from(new TextEncoder().encode(cleanText(text)))
    .map((byte) => String.fromCharCode(byte))
    .join('');
}

function decodeMidiText(text: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(text, (char) => char.charCodeAt(0)),
    );
  } catch {
    return text;
  }
}

export function toMidi(project: ScoreProject, partIds?: string[]): Uint8Array {
  assertValid(project);
  const parts = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  if (!parts.length) throw new Error('请至少选择一个声部。');
  if (parts.filter((part) => part.role !== 'percussion').length > 15)
    throw new Error('标准 MIDI 最多支持 15 个独立有音乐器声道；请分批导出。');
  if (parts.filter((part) => part.role === 'percussion').length > 1)
    throw new Error(
      '标准 GM MIDI 的打击乐共用第 10 通道，多个独立鼓轨可能互相切断同音。请单独导出打击声部，或用 MusicXML 保留完整分轨。',
    );
  const midi = new Midi();
  midi.name = encodeMidiText(project.title);
  midi.header.setTempo(project.tempo);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: project.timeSignature }];
  const key = normalizeKey(project.key);
  midi.header.meta.push({ ticks: 0, type: 'text', text: encodeMidiText(`Coro | ${project.composer}`) });
  midi.header.update();
  let channel = 0;
  parts.forEach((part) => {
    const track = midi.addTrack();
    track.name = encodeMidiText(part.name);
    if (part.role === 'percussion') track.channel = 9;
    else {
      if (channel === 9) channel++;
      track.channel = channel++;
    }
    track.instrument.number = part.program;
    track.addCC({ number: 7, ticks: 0, value: part.volume });
    track.addCC({ number: 10, ticks: 0, value: ((part.pan ?? 0) + 1) / 2 });
    track.endOfTrackTicks = Math.round(project.measures * beatsPerBar(project) * midi.header.ppq);
    performanceNotes(part, project.tempo)
      .filter((note) => note.midi !== null && note.velocity > 0)
      .forEach((note) =>
        track.addNote({
          midi: note.midi!,
          ticks: Math.round(note.start * midi.header.ppq),
          durationTicks: Math.max(1, Math.round(note.duration * noteGateRatio(note) * midi.header.ppq)),
          velocity: note.dynamic ? notePlaybackLevel(note) : note.velocity,
        }),
      );
  });
  // @tonejs/midi 2.0.28 adds rather than subtracts 7 when encoding fifths.
  // Write the standard SMF key event ourselves; minor keys use relative-major fifths.
  const raw = parseMidi(midi.toArray());
  raw.tracks[0].unshift({
    deltaTime: 0,
    meta: true,
    type: 'keySignature',
    key: FIFTHS[key],
    scale: key.endsWith('m') ? 1 : 0,
  });
  return new Uint8Array(writeMidi(raw));
}

export function fromMidi(bytes: ArrayBuffer): ScoreProject {
  if (bytes.byteLength > 20_000_000) throw new Error('MIDI 文件超过 20 MB 的安全上限。');
  if (new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))) !== 'MThd')
    throw new Error('文件不是有效的标准 MIDI。');
  let midi: MidiType;
  try {
    midi = new Midi(bytes);
  } catch {
    throw new Error('无法解析 MIDI 文件；文件可能损坏。');
  }
  const project = projectShell('midi', decodeMidiText(midi.name) || '导入的 MIDI');
  project.source.engine = 'Standard MIDI / GM program metadata';
  project.tempo = midi.header.tempos[0]?.bpm ?? 100;
  const meter = midi.header.timeSignatures[0]?.timeSignature;
  if (meter) project.timeSignature = [meter[0], meter[1]];
  const raw = parseMidi(new Uint8Array(bytes));
  const key = raw.tracks.flat().find((event) => event.type === 'keySignature');
  if (key?.type === 'keySignature') project.key = keyFromFifths(key.key, key.scale === 1);
  if (midi.header.tempos.length > 1)
    project.source.warnings.push('MIDI 包含速度变化；音符节拍位置保留，播放器使用第一个速度。');
  if (midi.header.timeSignatures.length > 1)
    project.source.warnings.push('MIDI 包含拍号变化；工作台按第一个拍号重新分小节。');
  if (midi.header.keySignatures.length > 1)
    project.source.warnings.push('MIDI 包含调号变化；音高保留，谱面统一使用第一个调号。');
  if (midi.tracks.some((track) => track.pitchBends.length))
    project.source.warnings.push('MIDI 弯音暂未导入；请核对滑音和微分音。');
  if (midi.tracks.some((track) => track.controlChanges[64]?.length))
    project.source.warnings.push('延音踏板暂未展开；保留的是 MIDI 按键时长。');
  project.parts = midi.tracks
    .filter((track) => track.notes.length > 0)
    .map((track, index) => {
      const pitches = track.notes.map((note) => note.midi).sort((a, b) => a - b);
      const bass = track.instrument.family === 'bass' || pitches[Math.floor(pitches.length / 2)] < 53;
      return {
        id: newId('part'),
        name: decodeMidiText(track.name) || track.instrument.name || `声部 ${index + 1}`,
        shortName: `P${index + 1}`,
        instrument: track.instrument.name.replace(/ /g, '_'),
        role: track.instrument.percussion ? 'percussion' : bass ? 'bass' : 'instrument',
        clef: track.instrument.percussion ? 'percussion' : bass ? 'bass' : 'treble',
        program: track.instrument.number,
        color: PALETTE[index % PALETTE.length],
        muted: false,
        solo: false,
        volume: track.controlChanges[7]?.[0]?.value ?? 0.8,
        pan: (track.controlChanges[10]?.[0]?.value ?? 0.5) * 2 - 1,
        notes: track.notes.map((note) => ({
          id: newId('note'),
          midi: note.midi,
          start: note.ticks / midi.header.ppq,
          duration: Math.max(1 / midi.header.ppq, note.durationTicks / midi.header.ppq),
          velocity: note.velocity,
          origin: 'manual' as const,
        })),
      };
    });
  if (!project.parts.length) throw new Error('MIDI 中没有可读取的音符。');
  const end = Math.max(
    midi.durationTicks / midi.header.ppq,
    ...project.parts.flatMap((part) => part.notes.map((note) => note.start + note.duration)),
  );
  project.measures = Math.max(1, Math.ceil((end - EPSILON) / beatsPerBar(project)));
  assertValid(project);
  return project;
}
