import type {
  ArrangementOptions,
  ArrangementPlan,
  ArrangementSectionPlan,
  ChordEvent,
  NoteEvent,
  ScorePart,
  ScoreProject,
} from './types';
import { beatsPerBar, newId, transposeChordSymbol, transposeKey, validateProject } from './music';
import { inferChords, inspectArrangement, recommendLeadPart } from './arrange';
import { planVocalBreaths } from './vocalBreathing';

const EPS = 1e-6;
const DYNAMICS = ['p', 'mp', 'mf', 'f', 'ff'] as const;
const VOICES = {
  S: { name: 'Soprano · 女高', short: 'S.', range: [60, 79] as [number, number], comfort: [62, 74], clef: 'treble' as const, color: '#6e826e', pan: -0.3 },
  A: { name: 'Alto · 女低', short: 'A.', range: [55, 72] as [number, number], comfort: [57, 69], clef: 'treble' as const, color: '#5e8195', pan: 0.3 },
  T: { name: 'Tenor · 男高', short: 'T.', range: [48, 67] as [number, number], comfort: [50, 64], clef: 'bass' as const, color: '#9a804e', pan: -0.12 },
  B: { name: 'Bass · 男低', short: 'B.', range: [40, 60] as [number, number], comfort: [41, 55], clef: 'bass' as const, color: '#887286', pan: 0.12 },
};
type Upper = 'S' | 'A' | 'T';
const UPPER: Upper[] = ['S', 'A', 'T'];
const pc = (pitch: number) => ((pitch % 12) + 12) % 12;
const overlaps = (note: NoteEvent, start: number, end: number) =>
  note.start < end - EPS && note.start + note.duration > start + EPS;

interface Slot {
  start: number;
  end: number;
  chord: ChordEvent;
  pcs: number[];
  bass: number;
  third?: number;
  seventh?: number;
}

function pitchClassFromName(name: string): number {
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[name[0] as 'C'];
  return pc(base + (name.slice(1).includes('#') ? 1 : name.slice(1).includes('b') ? -1 : 0));
}

function slotFor(chord: ChordEvent): Slot {
  const root = chord.symbol.match(/^([A-G][#b]?)/)?.[1];
  const slash = chord.symbol.match(/\/([A-G][#b]?)$/)?.[1];
  const pcs = [...new Set(chord.pitches.map(pc))];
  const rootPc = root ? pitchClassFromName(root) : pc(chord.pitches[0]);
  const has = (interval: number) => (pcs.includes(pc(rootPc + interval)) ? pc(rootPc + interval) : undefined);
  return {
    start: chord.start,
    end: chord.start + chord.duration,
    chord,
    pcs,
    bass: slash ? pitchClassFromName(slash) : rootPc,
    third: has(4) ?? has(3) ?? has(5),
    seventh: has(10) ?? has(11),
  };
}

export function defaultArrangementPlan(project: ScoreProject): ArrangementPlan {
  const bar = beatsPerBar(project);
  const lead = recommendLeadPart(project);
  const firstLead = lead?.notes.find((note) => note.midi !== null)?.start ?? 0;
  const introBars = Math.min(project.measures, Math.max(0, Math.floor(firstLead / bar)));
  const sections: ArrangementSectionPlan[] = [];
  if (introBars) sections.push({ id: 'intro', kind: 'intro', label: 'Intro', startBar: 1, bars: introBars, energy: 1, texture: 'bell', bass: 'sustain' });
  let start = introBars + 1;
  let index = 0;
  const kinds: ArrangementSectionPlan['kind'][] = ['verse', 'prechorus', 'chorus', 'verse', 'bridge', 'chorus'];
  while (start <= project.measures) {
    const remaining = project.measures - start + 1;
    const bars = remaining <= 4 ? remaining : Math.min(8, remaining);
    const kind = remaining <= 4 ? 'outro' : kinds[index % kinds.length];
    const nth = sections.filter((item) => item.kind === kind).length;
    const energy = kind === 'chorus' ? (nth ? 5 : 4) : kind === 'prechorus' ? 3 : kind === 'bridge' ? 2 : kind === 'outro' ? 1 : nth ? 3 : 2;
    sections.push({
      id: `${kind}-${index + 1}`,
      kind,
      label: kind === 'verse' ? `Verse ${nth + 1}` : kind === 'chorus' ? `Chorus ${nth + 1}` : kind[0].toUpperCase() + kind.slice(1),
      startBar: start,
      bars,
      energy: energy as ArrangementSectionPlan['energy'],
      texture: kind === 'chorus' ? 'lyric' : kind === 'prechorus' ? 'rhythm' : kind === 'bridge' || kind === 'outro' ? 'pad' : nth ? 'answer' : 'pad',
      bass: kind === 'chorus' ? 'groove' : kind === 'bridge' || kind === 'outro' ? 'sustain' : 'pulse',
    });
    start += bars;
    index++;
  }
  return { version: 2, planner: 'rule', ensemble: 'solo+satb', sections };
}

function slotsInRange(chords: ChordEvent[], from: number, to: number): Slot[] {
  return chords
    .filter((chord) => chord.start < to - EPS && chord.start + chord.duration > from + EPS)
    .map((chord) => ({ ...slotFor(chord), start: Math.max(from, chord.start), end: Math.min(to, chord.start + chord.duration) }));
}

function skeleton(slots: Slot[], lead: NoteEvent[], previous?: number[]): number[][] {
  const candidates = slots.map((slot) => {
    const leadHere = lead.filter((note) => overlaps(note, slot.start, slot.end));
    const voicePitches = UPPER.map((voice) =>
      Array.from({ length: VOICES[voice].range[1] - VOICES[voice].range[0] + 1 }, (_, i) => VOICES[voice].range[0] + i).filter((pitch) => slot.pcs.includes(pc(pitch))),
    );
    const result: Array<{ pitches: number[]; cost: number }> = [];
    for (const s of voicePitches[0])
      for (const a of voicePitches[1])
        for (const t of voicePitches[2]) {
          if (!(s > a && a > t) || s - a > 12 || a - t > 12) continue;
          const pitches = [s, a, t];
          let cost = pitches.reduce((sum, pitch, i) => {
            const [low, high] = VOICES[UPPER[i]].comfort;
            return sum + Math.max(0, low - pitch, pitch - high) * 0.8 + Math.abs(pitch - (low + high) / 2) * 0.04;
          }, 0);
          const classes = new Set([slot.bass, ...pitches.map(pc)]);
          if (slot.third !== undefined && !classes.has(slot.third)) cost += 6;
          if (slot.seventh !== undefined && !classes.has(slot.seventh)) cost += 2;
          cost += (3 - new Set(pitches.map(pc)).size) * 1.2;
          for (const note of leadHere)
            for (const pitch of pitches) {
              const distance = Math.abs(pitch - note.midi!);
              const weight = Math.min(slot.end, note.start + note.duration) - Math.max(slot.start, note.start);
              if (distance === 1 || distance === 13) cost += 5 * weight;
              if (pitch > note.midi! && note.midi! >= 64) cost += 0.6 * weight;
            }
          result.push({ pitches, cost });
        }
    return result.sort((a, b) => a.cost - b.cost).slice(0, 160);
  });
  if (!candidates.length) return [];
  let paths = candidates[0].map((candidate) => ({
    cost: candidate.cost + (previous ? candidate.pitches.reduce((sum, pitch, i) => sum + Math.abs(pitch - previous[i]) * 0.35, 0) : 0),
    path: [candidate.pitches],
  }));
  for (let index = 1; index < candidates.length; index++) {
    if (!candidates[index].length) throw new Error(`无法为 ${slots[index].chord.symbol} 安排人声和弦。`);
    paths = candidates[index].map((candidate) => {
      const best = paths
        .map((path) => {
          const last = path.path.at(-1)!;
          const movement = candidate.pitches.reduce((sum, pitch, i) => {
            const delta = Math.abs(pitch - last[i]);
            return sum + delta * 0.75 + Math.max(0, delta - 5) * 1.6 - (delta === 0 ? 0.25 : 0);
          }, 0);
          return { path, cost: path.cost + movement };
        })
        .sort((a, b) => a.cost - b.cost)[0];
      return { cost: best.cost + candidate.cost, path: [...best.path.path, candidate.pitches] };
    });
  }
  return paths.sort((a, b) => a.cost - b.cost)[0].path;
}

function attacks(pattern: string, bar: number): Array<{ start: number; duration: number }> {
  const result: Array<{ start: number; duration: number }> = [];
  [...pattern].forEach((char, i) => {
    if (char === 'x') result.push({ start: bar + i * 0.5, duration: 0.5 });
    if (char === '-' && result.length) result.at(-1)!.duration += 0.5;
  });
  return result;
}

export function arrangeV2(source: ScoreProject, options: ArrangementOptions, suppliedPlan?: ArrangementPlan): ScoreProject {
  const project = structuredClone(source);
  const lead = source.parts.find((part) => part.id === options.leadPartId) ?? recommendLeadPart(source);
  if (!lead) throw new Error('没有可保留的主旋律声部。');
  const leadNotes = lead.notes.filter((note) => note.midi !== null).map((note) => ({ ...note, midi: note.midi! + options.transpose }));
  if (!project.chords.length) project.chords = inferChords(project);
  project.chords = project.chords.map((chord) => ({
    ...chord,
    symbol: transposeChordSymbol(chord.symbol, options.transpose),
    pitches: chord.pitches.map((pitch) => pitch + options.transpose),
  }));
  const barLength = beatsPerBar(project);
  const total = project.measures * barLength;
  const plan = suppliedPlan ?? defaultArrangementPlan(source);
  const drafts: Record<'S' | 'A' | 'T' | 'B', NoteEvent[]> = { S: [], A: [], T: [], B: [] };
  const sourceBass = source.parts.find((part) => part.role === 'bass' && part.id !== lead.id);
  let previous: number[] | undefined;
  let previousBass = 47;
  for (const section of plan.sections) {
    const from = (section.startBar - 1) * barLength;
    const to = Math.min(total, from + section.bars * barLength);
    const slots = slotsInRange(project.chords, from, to);
    if (!slots.length) continue;
    const sectionLead = leadNotes.filter((note) => overlaps(note, from, to));
    const voices = skeleton(slots, sectionLead, previous);
    previous = voices.at(-1);
    const pitchAt = (voice: Upper, beat: number) => {
      const index = slots.findIndex((slot) => beat >= slot.start - EPS && beat < slot.end - EPS);
      return index < 0 ? undefined : voices[index][UPPER.indexOf(voice)];
    };
    const add = (voice: 'S' | 'A' | 'T' | 'B', midi: number | undefined, start: number, duration: number, lyric: string, first = false) => {
      if (midi === undefined || start >= to - EPS || duration <= EPS) return;
      drafts[voice].push({
        id: newId(`v2-${voice}`), midi, start, duration: Math.min(duration, to - start), lyric,
        velocity: 0.38 + section.energy * 0.08, origin: 'arranged', ...(first ? { dynamic: DYNAMICS[section.energy - 1] } : {}),
      });
    };
    const active = section.texture === 'sparse' ? (['A', 'T'] as Upper[]) : UPPER;
    for (const voice of active) {
      const voiceIndex = UPPER.indexOf(voice);
      if (section.texture === 'pad' || section.texture === 'sparse') {
        slots.forEach((slot, index) => add(voice, pitchAt(voice, slot.start), slot.start, Math.max(0.5, slot.end - slot.start - (slot.end >= to - EPS ? 0.5 : 0)), section.energy <= 1 ? 'Hmm' : 'Ooh', index === 0));
      } else if (section.texture === 'bell') {
        for (let bar = from; bar < to - EPS; bar += barLength) add(voice, pitchAt(voice, bar + voiceIndex * 0.5), bar + voiceIndex * 0.5, barLength - voiceIndex * 0.5 - 0.5, 'Dn', bar === from);
      } else if (section.texture === 'rhythm') {
        const patterns = ['x-.x-.x-', 'x.x-.x.x', '.x.x-.x.'];
        for (let bar = from; bar < to - EPS; bar += barLength)
          attacks(patterns[voiceIndex], bar).forEach((hit, hitIndex) => add(voice, pitchAt(voice, hit.start), hit.start, hit.duration, hit.duration > 0.5 ? 'doo' : hitIndex % 2 ? 'da' : 'dn', bar === from && hitIndex === 0));
      } else if (section.texture === 'answer') {
        sectionLead.forEach((note, index) => {
          const next = sectionLead[index + 1];
          const start = note.start + note.duration;
          const end = Math.min(next?.start ?? to, start + 2);
          if (end - start >= 1 - EPS) add(voice, pitchAt(voice, start), start, end - start - 0.25, voice === 'S' ? 'Ooh' : 'Doo', index === 0);
        });
        if (!drafts[voice].some((note) => note.start >= from && note.start < to))
          slots.forEach((slot) => add(voice, pitchAt(voice, slot.start), slot.start, slot.end - slot.start, 'Ooh'));
      } else if (section.texture === 'lyric') {
        if (voice === 'T') {
          slots.forEach((slot, index) => add(voice, pitchAt(voice, slot.start), slot.start, slot.end - slot.start, 'Ooh', index === 0));
        } else if (sectionLead.some((note) => note.lyric)) {
          sectionLead.forEach((note, index) => add(voice, pitchAt(voice, note.start), note.start, note.duration, note.lyric?.replace(/[,.?!，。？！]/g, '') || 'oo', index === 0));
        } else {
          // Without words, copying every melodic attack produces "Ooh" chatter. Follow phrase onsets and beat anchors instead.
          const anchors = sectionLead.filter((note, index) => {
            const previous = sectionLead[index - 1];
            return !previous || note.start - (previous.start + previous.duration) > 0.25 || Math.abs(note.start - Math.round(note.start)) < EPS;
          });
          anchors.forEach((note, index) => {
            const next = anchors[index + 1]?.start ?? to;
            const duration = Math.min(2, next - note.start);
            if (duration >= 0.5 - EPS) add(voice, pitchAt(voice, note.start), note.start, duration, index === 0 || note.start - (anchors[index - 1].start + 2) > EPS ? 'Doo' : 'oo', index === 0);
          });
        }
      }
    }
    const bassPitch = (beat: number) => {
      const slot = slots.find((item) => beat >= item.start - EPS && beat < item.end - EPS);
      if (!slot) return undefined;
      const sourceNote = sourceBass?.notes.find((note) => note.midi !== null && overlaps(note, beat, beat + 0.25));
      const target = sourceNote && slot.pcs.includes(pc(sourceNote.midi! + options.transpose)) ? pc(sourceNote.midi! + options.transpose) : slot.bass;
      const options12 = Array.from({ length: VOICES.B.range[1] - VOICES.B.range[0] + 1 }, (_, i) => VOICES.B.range[0] + i).filter((pitch) => pc(pitch) === target);
      const tenor = pitchAt('T', beat);
      const legal = options12.filter((pitch) => tenor === undefined || pitch < tenor);
      const midi = (legal.length ? legal : options12).sort((a, b) => Math.abs(a - previousBass) - Math.abs(b - previousBass))[0];
      previousBass = midi;
      return midi;
    };
    for (let bar = from, index = 0; bar < to - EPS; bar += barLength, index++) {
      if (section.bass === 'sustain') add('B', bassPitch(bar), bar, barLength - 0.5, 'Dm', index === 0);
      else if (section.bass === 'pulse') {
        add('B', bassPitch(bar), bar, 1.5, 'Dm', index === 0);
        add('B', bassPitch(bar + 2), bar + 2, 1.5, 'dm');
      } else
        attacks(index % 4 === 3 ? 'x-.x.xx-' : 'x-.xx-.x', bar).forEach((hit, hitIndex) => add('B', bassPitch(hit.start), hit.start, hit.duration, hit.duration > 0.5 ? 'dm' : 'dum', index === 0 && hitIndex === 0));
    }
  }
  const solo: ScorePart = {
    ...structuredClone(lead), id: 'solo', name: 'Solo · 主唱', shortName: 'Solo', instrument: 'choir_aahs', role: 'lead', roleSource: 'manual',
    program: 52, color: '#b35c42', notes: leadNotes.map((note) => ({ ...note, id: newId('solo') })), muted: false, solo: false, volume: 0.9, pan: 0,
    range: [Math.min(...leadNotes.map((note) => note.midi!)), Math.max(...leadNotes.map((note) => note.midi!))],
  };
  const finish = (key: 'S' | 'A' | 'T' | 'B'): ScorePart => {
    const voice = VOICES[key];
    const sorted = drafts[key].sort((a, b) => a.start - b.start).map((note, index, list) => ({ ...note, duration: Math.min(note.duration, (list[index + 1]?.start ?? total) - note.start) })).filter((note) => note.duration > EPS);
    return {
      id: `voice-${key.toLowerCase()}`, name: voice.name, shortName: voice.short, instrument: 'choir_aahs', role: key === 'B' ? 'bass' : 'harmony', clef: voice.clef,
      program: 52, color: voice.color, notes: planVocalBreaths(sorted, project.tempo, barLength, 10, () => newId(`breath-${key}`), 0.2).notes,
      muted: false, solo: false, volume: key === 'B' ? 0.74 : 0.6, pan: voice.pan, range: [...voice.range],
    };
  };
  project.parts = [solo, finish('S'), finish('A'), finish('T'), finish('B')];
  project.key = transposeKey(project.key, options.transpose);
  project.id = newId('arrangement');
  project.title = `${source.title.replace(/ · (SATB|SSAA|TTBB|Solo\+SATB)$/, '')} · Solo+SATB`;
  project.updatedAt = new Date().toISOString();
  project.createdAt = project.updatedAt;
  const changes = [
    `Solo 独立保留原主旋律：${leadNotes.length} 个音的起点、时值和歌词不改${options.transpose ? `，仅随整曲移调 ${options.transpose} 个半音` : '，不移八度、不折叠'}。`,
    ...plan.sections.map((section) => `${section.label} ${section.startBar}–${section.startBar + section.bars - 1} 小节：${section.texture} / bass ${section.bass} / 能量 ${section.energy}`),
  ];
  project.arrangement = { options: { ...options, preset: 'solo-satb', percussion: false, leadPartId: lead.id }, plan, report: { changes, warnings: [], ranges: [] } };
  const inspection = inspectArrangement(project);
  project.arrangement.report = { ...inspection, changes, warnings: inspection.warnings };
  const errors = validateProject(project);
  if (errors.length) throw new Error(`编配验证失败：${errors.join('\n')}`);
  return project;
}
