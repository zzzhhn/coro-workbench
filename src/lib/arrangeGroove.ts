import { frozenFormPlan } from './auditionPlan';
import { validWrittenSections } from './arrangementEngines';
import { inferChords, inspectArrangement, recommendLeadPart } from './arrange';
import { beatsPerBar, newId, transposeChordSymbol, transposeKey, validateProject } from './music';
import type { ArrangementOptions, ArrangementSectionPlan, ChordEvent, NoteEvent, ScorePart, ScoreProject } from './types';
import { planVocalBreaths } from './vocalBreathing';

const EPS = 1e-6;
const UPPER = [
  { id: 's', name: 'Soprano', range: [60, 77], center: 71, clef: 'treble', color: '#a85969', volume: .57, pan: -.24 },
  { id: 'a', name: 'Alto', range: [55, 69], center: 64, clef: 'treble', color: '#8063a5', volume: .51, pan: .19 },
  { id: 't', name: 'Tenor', range: [53, 65], center: 61, clef: 'treble8', color: '#477c8a', volume: .55, pan: -.11 },
] as const;
const BASS = { id: 'b', name: 'Bass', range: [40, 55], center: 46, clef: 'bass', color: '#426e57', volume: .72, pan: .10 } as const;
const NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
type Voice = typeof UPPER[number] | typeof BASS;
type Pitched = NoteEvent & { midi: number };
type Span = { start: number; end: number };
type Task = Span & { strength: number; lyric?: string };

const pc = (n: number) => (n % 12 + 12) % 12;
const pitchNameClass = (name: string) =>
  pc(NAMES[name.charAt(0)] + (name.charAt(1) === '#' ? 1 : name.charAt(1) === 'b' ? -1 : 0));
const endOf = (n: NoteEvent) => n.start + n.duration;
const overlap = (n: NoteEvent, span: Span) => Math.max(0, Math.min(span.end, endOf(n)) - Math.max(span.start, n.start));
const asPitched = (notes: NoteEvent[]): Pitched[] =>
  notes.filter((n): n is Pitched => n.midi !== null && n.velocity > 0).sort((a, b) => a.start - b.start);

function pitchesIn(classes: number[], [low, high]: readonly [number, number]) {
  return Array.from({ length: high - low + 1 }, (_, i) => low + i).filter((midi) => classes.includes(pc(midi)));
}

function bassClass(chord: ChordEvent) {
  const name = chord.symbol.match(/\/([A-G][b#]?)$/)?.[1] ?? chord.symbol.match(/^([A-G][b#]?)/)?.[1];
  return name ? pitchNameClass(name) : pc(Math.min(...chord.pitches));
}

function voicedPart(voice: Voice, notes: NoteEvent[]): ScorePart {
  return {
    id: `voice-${voice.id}`, name: voice.name, shortName: voice.id.toUpperCase(), role: voice.id === 'b' ? 'bass' : 'harmony',
    roleSource: 'manual', clef: voice.clef, program: 52, instrument: 'choir_aahs',
    color: voice.color, range: [...voice.range], volume: voice.volume, pan: voice.pan, muted: false, solo: false, notes,
  };
}

function scoreNote(voice: Voice, notes: NoteEvent[], midi: number, task: Task) {
  notes.push({
    id: `groove-${voice.id}-${notes.length + 1}`, midi, start: task.start, duration: task.end - task.start,
    velocity: task.strength, ...(task.lyric ? { lyric: task.lyric } : {}), origin: 'arranged',
  });
}

function scoreForm(source: ScoreProject, lead: Pitched[], bar: number): ArrangementSectionPlan[] {
  const given = source.source.arrangementSections;
  if (validWrittenSections(given, source.measures)) return structuredClone(given);
  const intro = Math.min(source.measures - 1, Math.floor(lead[0].start / bar));
  const last = Math.min(source.measures, Math.max(intro + 1, Math.ceil(lead.reduce((end, n) => Math.max(end, endOf(n)), 0) / bar)));
  return [
    ...(intro ? [{ id: 'intro', kind: 'intro', label: '前奏', startBar: 1, bars: intro, energy: 2, texture: 'rhythm', bass: 'groove' } as const] : []),
    { id: 'vocal', kind: 'verse', label: '演唱段', startBar: intro + 1, bars: last - intro, energy: 3, texture: 'pad', bass: 'groove' },
    ...(last < source.measures ? [{ id: 'outro', kind: 'outro', label: '尾声', startBar: last + 1, bars: source.measures - last,
      energy: 2, texture: 'pad', bass: 'groove' } as const] : []),
  ];
}

/** Group simultaneous pitches, preserve each recorded attack and avoid voice overlap. */
function mono(events: Pitched[], bass: boolean): Pitched[] {
  const selected: Pitched[] = [];
  for (const n of events) {
    const last = selected.at(-1);
    if (last && Math.abs(last.start - n.start) < EPS) {
      if (bass ? n.midi < last.midi : n.midi > last.midi) selected[selected.length - 1] = n;
    } else selected.push(n);
  }
  return selected.map((n, i) => ({ ...n, duration: Math.min(n.duration, (selected[i + 1]?.start ?? Infinity) - n.start) }))
    .filter(n => n.duration > EPS);
}

function fitMonody(input: Pitched[], voice: Voice, transpose: number, lyric: string, strength: number) {
  const notes: Pitched[] = [];
  for (const n of input) {
    const previous = notes.at(-1);
    const cost = (midi: number) => Math.abs(midi - voice.center) + (previous ? Math.abs(midi - previous.midi) * .7 : 0)
      + (voice.id === 's' ? Math.abs(midi - (n.midi + transpose)) * 1.65 : 0);
    const midi = pitchesIn([pc(n.midi + transpose)], voice.range).sort((a, b) => cost(a) - cost(b))[0];
    if (midi === undefined) continue;
    const task = { start: n.start, end: endOf(n), strength: strength + (n.velocity - .65) * .25,
      lyric: notes.length === 0 ? lyric : n.lyric };
    scoreNote(voice, notes, midi, task);
  }
  return notes;
}

function clash(a: number, b: number) {
  const distance = Math.abs(a - b);
  if (distance === 1 || distance === 13) return 34;
  if (distance === 2 || distance === 11) return .9;
  return 0;
}

function chooseVoicing(chord: ChordEvent, tasks: (Task | null)[], lead: Pitched[], bass: Pitched[],
                       motif: Pitched[], previous: number[], style: ArrangementOptions['style']) {
  const classes = [...new Set(chord.pitches.map(pc))];
  const rootName = chord.symbol.match(/^([A-G][b#]?)/)?.[1];
  const root = rootName ? pitchNameClass(rootName) : bassClass(chord);
  const has = (interval: number) => classes.find((p) => p === pc(root + interval));
  const third = has(3) ?? has(4) ?? has(5);
  const seventh = has(10) ?? has(11);
  // Compute note/voice costs once per slot. The joint loop only weighs spacing and coverage.
  const ranked = UPPER.map((voice, vi) => pitchesIn(classes, voice.range).map(midi => {
    const task = tasks[vi];
    const motion = Math.abs(midi - previous[vi]);
    let cost = Math.abs(midi - voice.center) * (voice.id === 't' ? 1.15 : .45) + motion * .43 + Math.max(0, motion - 5) * 1.1;
    if (task) {
      for (const note of lead) cost += overlap(note, task) * clash(midi, note.midi);
      for (const note of bass) {
        if (note.midi > midi && overlap(note, task) > EPS) cost += 60;
        if (overlap(note, task) >= .25) cost += overlap(note, task) * clash(midi, note.midi) * .67;
      }
      for (const note of motif) {
        if (note.midi < midi && overlap(note, task) > EPS) cost += 60;
        cost += overlap(note, task) * clash(midi, note.midi) * .7;
      }
    }
    return { midi, cost };
  }));
  let best = previous, bestCost = Infinity;
  for (const s of ranked[0]) for (const a of ranked[1]) for (const t of ranked[2]) {
    if (s.midi < a.midi || a.midi < t.midi) continue;
    const candidate = [s.midi, a.midi, t.midi];
    const members = new Set([bassClass(chord), ...candidate.map(pc)]);
    let total = s.cost + a.cost + t.cost + (s.midi === a.midi ? 6 : 0) + (a.midi === t.midi ? 6 : 0);
    if (third !== undefined && !members.has(third)) total += 8;
    if (seventh !== undefined && !members.has(seventh)) total += style === 'jazz' ? 3 : 1.6;
    total += (3 - new Set(candidate.map(pc)).size) * 1.55;
    for (const [vi, vj] of [[0, 1], [1, 2], [0, 2]]) {
      const distance = candidate[vi] - candidate[vj];
      total += (vi + 1 === vj ? Math.max(0, distance - 12) * 1.6 : 0);
      if (tasks[vi] && tasks[vj]) total += clash(candidate[vi], candidate[vj]);
    }
    if (total < bestCost) { best = candidate; bestCost = total; }
  }
  return Number.isFinite(bestCost) ? best : null;
}

function upperTasks(section: ArrangementSectionPlan, span: Span, lead: Pitched[], motif: Pitched[], bar: number, introStart: number,
                    style: ArrangementOptions['style']): (Task | null)[] {
  const length = span.end - span.start;
  const vocalCoverage = lead.reduce((sum, n) => sum + overlap(n, span), 0) / length;
  const firstBar = section.kind === 'intro' && span.start < introStart + bar - EPS;
  const strength = section.kind === 'chorus' ? .66 : section.kind === 'prechorus' ? .59 : .49;
  return UPPER.map(({ id }): Task | null => {
    if (length < .43) return null;
    if (id === 's' && motif.some(n => overlap(n, span) > EPS)) return null;
    if (firstBar && (id === 'a' || id === 't') && motif.length) return null;
    if (id === 's' && section.kind === 'verse' && vocalCoverage >= .45) return null;
    const offset = id === 's' && style !== 'choral' && ['chorus', 'prechorus'].includes(section.kind) && length >= 1.5 ? .5 : 0;
    return { start: span.start + offset, end: span.end, strength: strength - (id === 'a' ? .04 : 0) };
  });
}

function connect(notes: NoteEvent[], voice: Voice, source: ScoreProject, bar: number, seconds: number) {
  let count = 0;
  return planVocalBreaths(notes, source.tempo, bar, seconds, () => `groove-${voice.id}-breath-${++count}`, .2).notes;
}

export function arrangeGroove(source: ScoreProject, options: ArrangementOptions): ScoreProject {
  const errors = validateProject(source);
  if (errors.length) throw new Error(errors.join('；'));
  if (options.preset !== 'solo-satb' || !Number.isInteger(options.transpose) || Math.abs(options.transpose) > 24)
    throw new Error('律动编配需要 Solo + SATB；移调范围为上下 24 个半音。');
  const leadPart = source.parts.find(p => p.id === options.leadPartId) ?? recommendLeadPart(source);
  const lead = leadPart && asPitched(leadPart.notes);
  if (!leadPart || !lead?.length) throw new Error('没有可保留的主旋律音符。');
  if (lead.some(n => n.midi + options.transpose < 0 || n.midi + options.transpose > 127))
    throw new Error('主旋律移调后超出 MIDI 音域。');

  const project = structuredClone(source);
  const bar = beatsPerBar(source);
  const total = bar * source.measures;
  const transpose = options.transpose;
  const frozen = frozenFormPlan(options, source.measures);
  const sections = frozen?.sections ?? scoreForm(source, lead, bar);
  const leadNotes = lead.map(n => ({ ...n, midi: n.midi + transpose }));
  const writtenChords = source.chords.filter(chord => chord.pitches.length);
  project.chords = (writtenChords.length ? writtenChords : inferChords(source)).map(chord => ({
    ...chord, symbol: transposeChordSymbol(chord.symbol, transpose),
    pitches: chord.pitches.map(n => n + transpose).filter(n => n >= 0 && n <= 127),
  })).filter(chord => chord.pitches.length && chord.start < total - EPS).sort((a, b) => a.start - b.start);
  if (!project.chords.length) throw new Error('律动编配需要可读的和弦或可推断和声的伴奏。');
  const bassPart = source.parts.find(p => p.id === options.bassPartId && p.id !== leadPart.id) ??
    source.parts.find(p => p.role === 'bass' && p.id !== leadPart.id);
  const sourceBass = bassPart ? mono(asPitched(bassPart.notes), true) : [];
  const selected = new Set(options.accompanimentIds);
  const cueParts = source.parts.filter(p => selected.has(p.id) && p.role === 'instrument' && p.id !== bassPart?.id && p.id !== leadPart.id);
  const cueSource = mono(asPitched(cueParts.flatMap(p => p.notes)), false);
  const sopranoCues = fitMonody(cueSource, UPPER[0], transpose, 'du', .61);

  const slots = project.chords.map((chord, i) => ({
    chord, start: chord.start,
    end: Math.min(chord.start + chord.duration, project.chords[i + 1]?.start ?? total, total),
  })).filter(slot => slot.end > slot.start + EPS);
  const bass = fitMonody(sourceBass, BASS, transpose, 'dum', .69);
  if (!bass.length) for (const { chord, start, end } of slots) {
    const notes = pitchesIn([bassClass(chord)], BASS.range);
    const midi = notes.sort((a, b) => Math.abs(a - BASS.center) - Math.abs(b - BASS.center))[0];
    if (midi !== undefined) scoreNote(BASS, bass, midi, { start, end, strength: .63, lyric: bass.length ? undefined : 'dum' });
  }

  const drafts: NoteEvent[][] = [[], [], []];
  const motifAt = (span: Span) => sopranoCues.filter(n => overlap(n, span) > EPS);
  let voicing: number[] = UPPER.map(v => v.center);
  let sectionIndex = 0;
  for (const slot of slots) {
    while (sectionIndex < sections.length - 1 && slot.start >= (sections[sectionIndex + 1].startBar - 1) * bar - EPS) sectionIndex++;
    const section = sections[sectionIndex];
    const leadHere = leadNotes.filter(n => overlap(n, slot) > EPS);
    const bassHere = bass.filter(n => overlap(n, slot) > EPS);
    const motif = motifAt(slot);
    const tasks = upperTasks(section, slot, leadHere, motif, bar, (section.startBar - 1) * bar, options.style);
    const next = chooseVoicing(slot.chord, tasks, leadHere, bassHere, motif, voicing, options.style);
    if (!next) continue;
    voicing = next;
    for (const [vi, task] of tasks.entries()) {
      if (!task) continue;
      const notes = drafts[vi];
      const previous = notes.at(-1);
      const midi = voicing[vi];
      if (previous?.midi === midi && Math.abs(endOf(previous) - task.start) < EPS) {
        previous.duration = task.end - previous.start;
      } else {
        scoreNote(UPPER[vi], notes, midi, {
          ...task,
          lyric: !previous || task.start - endOf(previous) >= 2 ? (vi === 2 ? 'du' : 'oo') : undefined,
        });
      }
    }
  }

  drafts[0].push(...sopranoCues.map((note, i) => ({ ...note, id: `groove-s-cue-${i+1}` })));
  const { stemUrl: _stem, sourceId: _sourceId, pedals: _pedals, pedalSustain: _pedalSustain, staves: _staves, ...solo } = leadPart;
  const phraseSeconds = options.difficulty === 'easy' ? 8 : options.difficulty === 'advanced' ? 11 : 9;
  project.parts = [{
    ...solo, id: 'solo', name: 'Solo · 主唱', shortName: 'Solo', instrument: 'choir_aahs', role: 'lead', roleSource: 'manual',
    program: 52, clef: leadPart.clef === 'percussion' ? 'treble' : leadPart.clef, notes: leadNotes, volume: .92, pan: 0,
    muted: false, solo: false, range: [leadNotes.reduce((a, n) => Math.min(a, n.midi), 127), leadNotes.reduce((a, n) => Math.max(a, n.midi), 0)],
  }, ...UPPER.map((voice, i) => voicedPart(voice, connect(drafts[i], voice, source, bar, phraseSeconds))), voicedPart(BASS, connect(bass, BASS, source, bar, phraseSeconds))];
  project.id = newId('arrangement');
  project.title = `${source.title.replace(/ · Solo\+SATB$/, '')} · Solo+SATB`;
  project.key = transposeKey(source.key, transpose);
  project.updatedAt = new Date().toISOString();
  project.arrangement = {
    options: { ...options, engine: 'groove', percussion: false, leadPartId: leadPart.id },
    plan: frozen ?? { version: 2, planner: validWrittenSections(source.source.arrangementSections, source.measures) ? 'manual' : 'rule', ensemble: 'solo+satb', sections },
    revision: 1,
    report: { warnings: [], changes: [], ranges: [] },
  };
  const report = inspectArrangement(project);
  if (!sourceBass.length) report.warnings.push('没有可用的独立低音轨，Bass 由可用和弦的根音或转位低音支撑。');
  if (!writtenChords.length) report.warnings.push('源谱没有可用的和弦标记，伴唱使用推断和弦，请对照原曲。');
  report.changes = [
    `Solo 保留已选主旋律的 ${leadNotes.length} 个发声音符、起拍和时值。`,
    sourceBass.length ? 'Bass 保留独立源轨的起音与音级，移入可唱音区。' : 'Bass 按和弦到点支撑。',
    '上三部沿和声变化连接共同音，空拍和乐句换气分开处理。',
  ];
  project.arrangement.report = report;
  const finalErrors = validateProject(project);
  if (finalErrors.length) throw new Error(finalErrors.join('；'));
  return project;
}
