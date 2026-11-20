import { inferChords, inspectArrangement, recommendLeadPart } from './arrange';
import { validWrittenSections } from './arrangementEngines';
import { beatsPerBar, newId, transposeChordSymbol, transposeKey, validateProject } from './music';
import type { ArrangementOptions, ArrangementSectionPlan, ChordEvent, NoteEvent, ScorePart, ScoreProject } from './types';
import { planVocalBreaths, vocalPhrases } from './vocalBreathing';

const epsilon = 1e-7;
const voiceKeys = ['S', 'A', 'T', 'B'] as const;
type Voice = (typeof voiceKeys)[number];
type Voicing = [number, number, number, number];
const voices = {
  S: { name: 'Soprano · 女高', range: [64, 77], target: 69, clef: 'treble', color: '#6e826e', volume: 0.49, pan: -0.28 },
  A: { name: 'Alto · 女低', range: [56, 71], target: 64, clef: 'treble', color: '#5e8195', volume: 0.52, pan: 0.27 },
  T: { name: 'Tenor · 男高', range: [53, 64], target: 60, clef: 'treble8', color: '#9a804e', volume: 0.53, pan: -0.13 },
  B: { name: 'Bass · 男低', range: [40, 54], target: 47, clef: 'bass', color: '#887286', volume: 0.65, pan: 0.10 },
} satisfies Record<Voice, { name: string; range: [number, number]; target: number; clef: ScorePart['clef']; color: string; volume: number; pan: number }>;

const pc = (pitch: number) => ((pitch % 12) + 12) % 12;
const endOf = (note: NoteEvent) => note.start + note.duration;
const pitchClass = (spelling: string) => {
  const natural: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return pc(natural[spelling[0]] + (spelling[1] === '#' ? 1 : spelling[1] === 'b' ? -1 : 0));
};

function inferSections(measures: number, barLength: number, lead: NoteEvent[], chords: ChordEvent[]): ArrangementSectionPlan[] {
  const bars = Array.from({ length: measures }, (_, i) => {
    const start = i * barLength;
    const attacks = lead.filter(n => n.start >= start && n.start < start + barLength);
    const active = lead.some(n => n.start < start + barLength && endOf(n) > start + epsilon);
    const harmony = chords.find(c => c.start <= start && c.start + c.duration > start)?.symbol ?? '';
    return { attacks, active, start, harmony };
  });
  const signatures = new Map<string, number[]>();
  const refrainBars = new Set<number>();
  for (let i = 0; i + 4 <= bars.length; i++) {
    const phrase = bars.slice(i, i + 4);
    if (phrase.some(b => !b.active) || phrase.reduce((n, b) => n + b.attacks.length, 0) < 12) continue;
    const signature = JSON.stringify(phrase.map(b => [b.harmony, b.attacks.map(n => [n.midi, Math.round((n.start - b.start) * 4)])]));
    const previous = signatures.get(signature) ?? [];
    for (const match of previous.filter(j => j + 4 <= i)) {
      for (let offset = 0; offset < 4; offset++) { refrainBars.add(i + offset); refrainBars.add(match + offset); }
    }
    previous.push(i);
    signatures.set(signature, previous);
  }
  const firstLead = bars.findIndex(b => b.active);
  const lastLead = bars.reduce((last, b, i) => b.active ? i : last, -1);
  const sections: ArrangementSectionPlan[] = [];
  for (let i = 0; i < bars.length; i++) {
    const kind = i < firstLead ? 'intro' : i > lastLead ? 'outro'
      : refrainBars.has(i) ? 'chorus'
      : !bars[i].active && (bars[i - 1]?.active === false || bars[i + 1]?.active === false) ? 'interlude' : 'verse';
    const prior = sections.at(-1);
    if (prior?.kind === kind) { prior.bars++; continue; }
    const policy = kind === 'chorus' ? ['副歌',3,'rhythm','groove'] as const
      : kind === 'intro' ? ['引子',1,'bell','sustain'] as const
      : kind === 'interlude' ? ['间奏',2,'rhythm','pulse'] as const
      : kind === 'outro' ? ['尾奏',1,'pad','sustain'] as const
      : ['主歌',2,'pad','pulse'] as const;
    sections.push({ id: `section-${i + 1}`, kind, label: policy[0], startBar: i + 1, bars: 1,
      energy: policy[1], texture: policy[2], bass: policy[3], rationale: '按可识别的主唱留白、重复乐句与和声确定背景密度。' });
  }
  return sections;
}

interface Slot extends ChordEvent {
  section: ArrangementSectionPlan;
  end: number;
  bassPc: number;
  root: number;
}

function voicingOptions(slot: Slot, localLead: NoteEvent[]) {
  const classes = new Set(slot.pitches.map(pc));
  const possible = (voice: Voice) => {
    const [lo, hi] = voices[voice].range;
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).filter(n => voice === 'B' ? pc(n) === slot.bassPc : classes.has(pc(n)));
  };
  const [sopranos, altos, tenors, basses] = voiceKeys.map(possible);
  const availableDegree = (intervals: number[]) => intervals.map(n => pc(slot.root + n)).find(n => classes.has(n));
  const third = availableDegree([4, 3, 5]);
  const seventh = availableDegree(slot.symbol.includes('dim') ? [9] : [10, 11]);
  const color = availableDegree(slot.symbol.includes('6') ? [9, 2] : slot.symbol.includes('13') ? [9] : slot.symbol.includes('9') ? [2] : []);
  const upperCost = new Map<number, number>();
  const localCost = (pitch: number) => {
    if (!upperCost.has(pitch)) upperCost.set(pitch, localLead.reduce((sum, note) => {
      const length = Math.min(slot.end, endOf(note)) - Math.max(slot.start, note.start);
      const interval = Math.abs(pitch - note.midi!);
      return sum + length * (interval === 1 ? 3.1 : interval === 13 ? 0.9 : interval === 0 ? 0.45 : 0);
    }, 0));
    return upperCost.get(pitch)!;
  };
  const out: Array<{ pitches: Voicing; cost: number }> = [];
  for (const s of sopranos) for (const a of altos) for (const t of tenors) for (const b of basses) {
    if (s <= a || a <= t || t <= b || s - a > 12 || a - t > 12) continue;
    const pitches: Voicing = [s, a, t, b];
    const written = new Set(pitches.map(pc));
    const lift = slot.section.kind === 'chorus' ? 1 : 0;
    const tessitura = Math.abs(s - (voices.S.target + lift)) * 0.55 + Math.abs(a - voices.A.target) * 0.45
      + Math.abs(t - (voices.T.target + lift * 0.5)) * 1.35 + Math.abs(b - voices.B.target) * 0.12;
    const coverage = (third !== undefined && !written.has(third) ? 8 : 0)
      + (seventh !== undefined && !written.has(seventh) ? 4.6 : 0)
      + (color !== undefined && !written.has(color) ? 1.55 : 0)
      + (Math.min(classes.size, 4) - written.size) * 1.3;
    const spacing = (s - a === 1 ? 2.5 : 0) + (a - t === 1 ? 2.5 : 0);
    const cost = tessitura + coverage + spacing + localCost(s) + localCost(a) + localCost(t) * 0.75 + localCost(b) * 0.13;
    out.push({ pitches, cost });
  }
  // A fifthless or single-pitch cue can require an SATB note to share a pitch.
  // Use the closest octave placements and retain the sounding pitch classes.
  if (!out.length) {
    const nearest = (choices: number[], target: number) => [...choices].sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    const b = nearest(basses, voices.B.target);
    const t = nearest(tenors.filter(n => n >= b), voices.T.target);
    const a = nearest(altos.filter(n => n >= t), voices.A.target);
    const s = nearest(sopranos.filter(n => n >= a), voices.S.target);
    if ([s, a, t, b].every(Number.isFinite)) out.push({ pitches: [s,a,t,b], cost: 5 });
  }
  return out.sort((a, b) => a.cost - b.cost).slice(0, 30);
}

function voiceHarmony(slots: Slot[], lead: NoteEvent[]) {
  const rows = slots.map(slot => voicingOptions(slot, lead.filter(n => n.start < slot.end && endOf(n) > slot.start)));
  const paths: Array<Array<{ cost: number; previous: number }>> = [];
  for (const [i, row] of rows.entries()) {
    if (!row.length) throw new Error(`和弦 ${slots[i].symbol} 无法安排在当前的 SATB 音域内。`);
    paths.push(row.map(candidate => {
      if (i === 0) return { cost: candidate.cost, previous: -1 };
      let best = { cost: Infinity, previous: -1 };
      rows[i - 1].forEach((prior, j) => {
        const movement = candidate.pitches.reduce((sum, note, voice) => {
          const leap = Math.abs(note - prior.pitches[voice]);
          return sum + (leap ? leap * (voice === 3 ? 0.39 : 0.55) + Math.max(0, leap - 5) * 1.2 : -0.24);
        }, 0);
        const cost = paths[i - 1][j].cost + movement + candidate.cost;
        if (cost < best.cost) best = { cost, previous: j };
      });
      return best;
    }));
  }
  const tail = paths.at(-1) ?? [];
  let index = tail.reduce((best, candidate, j) => candidate.cost < (tail[best]?.cost ?? Infinity) ? j : best, -1);
  return rows.map((_, i) => i).reverse().map(i => {
    const pitches = rows[i][index].pitches;
    index = paths[i][index].previous;
    return pitches;
  }).reverse();
}

interface Cue { voice: Voice; at: number; length: number; word: string; gain?: number; accent?: boolean; triplet?: boolean }

function jazzCues(section: ArrangementSectionPlan, index: number, indexInSection: number, busy: boolean,
  closing: boolean, hasPhraseEnd: boolean, canUseTriplet: boolean): Cue[] {
  const cues: Cue[] = [];
  const add = (voice: Voice, at: number, length: number, word: string, gain?: number, accent?: boolean) =>
    cues.push({ voice, at, length, word, gain, accent });
  const odd = indexInSection % 2 === 1;
  if (section.kind === 'outro') {
    if (closing) {
      add('B', 0, 3.5, 'mm', 0.78); add('T', 0, 3.5, 'oo', 0.68);
      add('A', 0.5, 3, 'oo', 0.67); add('S', 1, 2.5, 'oo', 0.64);
    } else {
      add('B', 0, 1.5, 'dm', 0.82); add('T', 0.75, 2.5, 'oo', 0.82);
      if (hasPhraseEnd) add('A', 1.5, 2, 'oo', 0.75);
      else add('A', 0.5, 2.75, 'oo', 0.75);
      if (odd && !busy) add('S', 2.25, 1.25, 'oo', 0.68);
    }
  } else if (section.kind === 'bridge' || section.texture === 'sparse') {
    add('B', 0, 1.25, 'dm'); add('T', 0.25, 1.5, 'oo', 0.85); add('A', 0.75, 1, 'oo', 0.78);
    if (!busy) add('S', 2, 1.5, 'oo', 0.73);
  } else if (section.kind === 'intro' && indexInSection === 0) {
    add('B', 0, 1.25, 'dm', 0.76); add('A', 0.5, 1.75, 'oo', 0.74);
    add('S', 1, 2.5, 'oo', 0.79); add('T', 1.5, 0.5, 'doo', 0.83);
    if (canUseTriplet) for (let member = 0; member < 3; member++) {
      cues.push({ voice: 'T', at: 2 + member / 3, length: 1 / 3, word: 'du', gain: 0.73, triplet: true });
    } else add('T', 2.25, 1, 'doo', 0.89);
    add('B', 2.5, 0.75, 'dm', 0.75);
  } else if (section.kind === 'chorus') {
    add('B', 0, 1.5, 'dum'); add('B', 2, 0.5, 'dm', 0.88);
    if (indexInSection % 4 !== 3) add('B', 2.75, 0.75, 'dm', 0.97, true);
    add('T', 0.5, busy ? 2.75 : 1.25, 'doo', 0.91);
    add('A', odd ? 0.5 : 1, 0.75, 'doo', 0.88);
    add('A', 2.25, busy ? 0.75 : 1.25, 'doo', 0.89, true);
    if (!busy) add('T', 2.25, 1.25, 'doo', 0.82);
    add('S', section.energy >= 4 ? 0.5 : 1.5, busy ? 1.25 : 2, 'oo', 0.80);
    if (section.energy >= 4 && !busy && !odd) add('S', 3.25, 0.75, 'doo', 0.83, true);
  } else {
    // Quarter-note foundation, a late bass anticipator, and two interleaved
    // comping cells. Dense melody gets a longer inner-voice vowel and fewer hits.
    add('B', 0, 1.25, 'dum', 0.92); add('B', 2, 0.75, 'dm', 0.84);
    if (!odd || section.texture === 'rhythm') add('B', 2.75, 0.75, 'dm', 0.85, true);
    add('T', 0.5, busy ? 2.75 : 0.75, 'doo', 0.9);
    if (!busy) add('T', 2.25, 1, 'doo', 0.85, true);
    add('A', odd ? 0.75 : 1.5, odd ? 1.25 : 0.5, 'doo', 0.83);
    if (!busy) add('A', odd ? 2.25 : 3.25, 0.75, 'doo', 0.84, true);
    if (!busy && (section.kind === 'interlude' || section.kind === 'intro' || indexInSection % 4 === 2))
      add('S', odd ? 1.5 : 2.25, odd ? 1.75 : 1.25, 'oo', 0.70);
    else if (!busy && index % 4 === 3) add('S', 3.25, 0.75, 'oo', 0.72);
  }
  return cues;
}

export function arrangeJazzBallad(source: ScoreProject, options: ArrangementOptions): ScoreProject {
  if (options.preset !== 'solo-satb') throw new Error('爵士抒情编配需要 Solo + SATB。');
  const original = source.parts.find(p => p.id === options.leadPartId) ?? recommendLeadPart(source);
  const lead = (original?.notes ?? []).filter(n => n.midi !== null)
    .map(n => ({ ...n, midi: n.midi! + options.transpose })).sort((a, b) => a.start - b.start);
  if (!original || !lead.length) throw new Error('没有可保留的主唱声部。');
  const barLength = beatsPerBar(source);
  const charts = (source.chords.length ? source.chords : inferChords(source)).map(chord => ({
    ...chord, symbol: transposeChordSymbol(chord.symbol, options.transpose), pitches: chord.pitches.map(n => n + options.transpose),
  }));
  const writtenSections = source.source.arrangementSections;
  const hasWrittenSections = validWrittenSections(writtenSections, source.measures);
  const sections = hasWrittenSections ? structuredClone(writtenSections) : inferSections(source.measures, barLength, lead, charts);
  const sectionAt = (beat: number) => sections.find(s => beat >= (s.startBar - 1) * barLength - epsilon && beat < (s.startBar + s.bars - 1) * barLength - epsilon)!;
  const slots: Slot[] = charts.flatMap(chord => {
    if (!chord.pitches.length) return [];
    const spelling = /^([A-G][#b]?)/.exec(chord.symbol)?.[1];
    const bass = /\/([A-G][#b]?)$/.exec(chord.symbol)?.[1];
    const root = spelling ? pitchClass(spelling) : pc(chord.pitches[0]);
    return [{ ...chord, root, end: chord.start + chord.duration, section: sectionAt(chord.start), bassPc: bass ? pitchClass(bass) : root }];
  });
  if (!slots.length) throw new Error('需要有音高的可用和弦。');
  const harmony = voiceHarmony(slots, lead);
  const leadPhrases = vocalPhrases(lead, source.tempo);
  const available: Record<Voice, NoteEvent[]> = { S: [], A: [], T: [], B: [] };
  const pulseUnit = barLength / 4;
  const grid = Math.min(0.25, pulseUnit / 4);
  const quantize = (beat: number) => Math.round(beat / grid) * grid;
  const minGate = 0.25 * source.tempo / 60;
  for (let measure = 0; measure < source.measures; measure++) {
    const start = measure * barLength;
    const end = start + barLength;
    const section = sectionAt(start);
    const attacking = lead.filter(n => n.start >= start && n.start < end);
    const dense = attacking.length >= Math.max(6, Math.ceil(barLength * 1.65));
    const sectionIndex = measure - section.startBar + 1;
    const hasPhraseEnd = leadPhrases.some(p => p.end > start && p.end < end - epsilon);
    const canUseTriplet = barLength === 4 && source.tempo <= 80 && !attacking.length;
    const cues = jazzCues(section, measure, sectionIndex, dense, measure === source.measures - 1, hasPhraseEnd, canUseTriplet);
    for (const [si, slot] of slots.entries()) {
      if (slot.end <= start + epsilon || slot.start >= end - epsilon) continue;
      const picture = [...cues];
      // Every real harmonic change gets a bass arrival. A chord in the source
      // can be shorter than the pulse; it still gets exactly its own space.
      if (slot.start >= start - epsilon && !picture.some(c => c.voice === 'B' && Math.abs(start + quantize(c.at * pulseUnit) - slot.start) < epsilon)) {
        picture.push({ voice: 'B', at: (slot.start - start) / pulseUnit, length: Math.min(1.25, (slot.end - slot.start) / pulseUnit), word: 'dm', gain: 0.85 });
      }
      for (const cue of picture) {
        const face = (pulse: number) => cue.triplet ? pulse * pulseUnit : quantize(pulse * pulseUnit);
        const onset = start + face(cue.at);
        const release = Math.min(end, start + face(cue.at + cue.length));
        const a = Math.max(onset, slot.start);
        const b = Math.min(release, slot.end);
        const minimum = Math.min(Math.max(grid, minGate), slot.duration * 0.65);
        if (b - a < minimum - epsilon) continue;
        const octave = harmony[si][voiceKeys.indexOf(cue.voice)];
        const velocity = Math.min(0.84, (0.37 + 0.075 * section.energy) * (cue.gain ?? 1));
        available[cue.voice].push({ id: `jazz-${cue.voice}-${measure + 1}-${available[cue.voice].length + 1}`,
          start: a, duration: b - a, midi: octave, velocity, lyric: cue.word, origin: 'arranged',
          ...(cue.accent ? { articulation: 'accent' } : {}),
        });
      }
    }
  }
  const createdAt = new Date().toISOString();
  const dry: ScoreProject = {
    ...structuredClone(source), id: newId('arrangement'),
    title: `${source.title.replace(/ · (Solo\+SATB|SATB|SSAA|TTBB)$/, '')} · Solo+SATB`,
    key: transposeKey(source.key, options.transpose), chords: charts,
    createdAt, updatedAt: createdAt, parts: [],
  };
  const solo: ScorePart = { ...structuredClone(original), id: 'solo', name: 'Solo · 主唱', shortName: 'Solo',
    instrument: 'choir_aahs', role: 'lead', roleSource: 'manual', program: 52, color: '#b35c42', notes: lead,
    muted: false, solo: false, volume: 0.90, pan: 0, range: [Math.min(...lead.map(n => n.midi!)), Math.max(...lead.map(n => n.midi!))] };
  const breathStats: Record<string, ReturnType<typeof planVocalBreaths>> = {};
  const targetPhrase = options.difficulty === 'easy' ? 8 : options.difficulty === 'advanced' ? 11 : 9;
  const backing = voiceKeys.map((key): ScorePart => {
    const definition = voices[key];
    const candidates = available[key].sort((a, b) => a.start - b.start || b.duration - a.duration);
    const ordered: NoteEvent[] = [];
    for (const note of candidates) {
      const previous = ordered.at(-1);
      if (previous && Math.abs(note.start - previous.start) < epsilon) continue;
      if (previous && endOf(previous) > note.start + epsilon) previous.duration = note.start - previous.start;
      ordered.push(note);
    }
    // A printed long vowel joins only exact, identical harmony across a seam.
    const connected: NoteEvent[] = [];
    for (const note of ordered.filter(n => n.duration >= grid - epsilon)) {
      const previous = connected.at(-1);
      if (note.lyric === 'oo' && previous?.lyric === 'oo' && previous.midi === note.midi && !note.articulation
        && Math.abs(endOf(previous) - note.start) < epsilon && endOf(note) - previous.start < targetPhrase * source.tempo / 60) {
        previous.duration = endOf(note) - previous.start;
      } else connected.push(note);
    }
    let cutIndex = 0;
    const result = planVocalBreaths(connected, source.tempo, barLength, targetPhrase, () => `jazz-${key}-breath-${++cutIndex}`, 0.20);
    let previousSection: string | undefined;
    for (const note of result.notes) {
      const section = sectionAt(note.start);
      if (section.id === previousSection) continue;
      note.dynamic = (['pp', 'p', 'mp', 'mf', 'f'] as const)[section.energy - 1];
      previousSection = section.id;
    }
    const id = `voice-${key.toLowerCase()}`;
    breathStats[id] = result;
    return { id, name: definition.name, shortName: `${key}.`, range: definition.range, clef: definition.clef, instrument: 'choir_aahs',
      role: key === 'B' ? 'bass' : 'harmony', program: 52, color: definition.color, notes: result.notes,
      muted: false, solo: false, volume: definition.volume, pan: definition.pan };
  });
  dry.parts = [solo, ...backing];
  const changes = [
    `保留 Solo 的 ${lead.length} 个音头、时值和已有字位。`,
    '低声独立踩拍和处理和声到达，内声错开切分，在较密的主唱下留长元音。',
    '联合安排 SATB 音区、共同音和换气，保留源谱提供的段落与和声边界。',
  ];
  const plan = { version: 2 as const, planner: hasWrittenSections ? 'manual' as const : 'rule' as const,
    ensemble: 'solo+satb' as const, sections };
  dry.arrangement = { options: { ...options, engine: 'jazz-ballad', percussion: false, leadPartId: original.id }, plan, report: { changes, warnings: [], ranges: [] } };
  const inspection = inspectArrangement(dry);
  dry.arrangement.report = { ...inspection, changes, breathing: inspection.breathing?.map(row => ({
    ...row, ...(breathStats[row.partId] && { plannedGaps: breathStats[row.partId].cuts }),
  })) };
  const errors = validateProject(dry);
  if (errors.length) throw new Error(`爵士抒情编配验证失败：${errors.join('\n')}`);
  return dry;
}
