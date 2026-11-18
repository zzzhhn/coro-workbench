import { beatsPerBar, newId, validateProject } from './music';
import { inspectArrangement } from './arrange';
import { applyFormCuts, type FormCut } from './arrangementForm';
import { planVocalBreaths } from './vocalBreathing';
import type { NoteEvent, ScorePart, ScoreProject } from './types';

const eps = 1e-6;
const sounding = (n: NoteEvent) => n.midi !== null && n.velocity > 0;
const crosses = (n: NoteEvent, a: number, b: number) =>
  sounding(n) && n.start < b - eps && n.start + n.duration > a + eps;
const semitoneClash = (a: number, b: number) => [1, 11].includes(Math.abs(a - b) % 12);
const activeNotes = (part: ScorePart) => part.notes.filter(sounding);
interface Span {
  from: number;
  to: number;
  sung: boolean;
}
interface Gesture extends Span {
  source: string;
  carrier: string;
  attacks: number;
}
function spansOf(source: ScoreProject, lead: ScorePart): Span[] {
  const bar = beatsPerBar(source);
  const spans: Span[] = [];
  const notes = activeNotes(lead);
  for (let i = 0; i < source.measures; i++) {
    const from = i * bar,
      to = from + bar;
    const sung = notes.some((n) => crosses(n, from, to));
    const last = spans.at(-1);
    if (last && last.sung === sung) last.to = to;
    else spans.push({ from, to, sung });
  }
  return spans;
}

// A written staff/voice is stronger evidence than the top note of a mixed keyboard part.
function backingLines(source: ScoreProject, lead: ScorePart) {
  return source.parts
    .filter((p) => p.id !== lead.id && !['percussion', 'bass'].includes(p.role))
    .flatMap((p) => {
      const groups = new Map<string, NoteEvent[]>();
      for (const n of activeNotes(p)) {
        const key = [n.staff ?? '', n.voice ?? ''].join('/');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(n);
      }
      return [...groups.values()].map((notes) => {
        const attacks = new Map<number, NoteEvent>();
        for (const n of notes) {
          const t = Math.round(n.start * 192) / 192;
          if ((attacks.get(t)?.midi ?? -1) < n.midi!) attacks.set(t, n);
        }
        return {
          source: p.name,
          clarity: attacks.size / notes.length,
          notes: [...attacks.values()].sort((a, b) => a.start - b.start),
        };
      });
    });
}

function replaceSpan(part: ScorePart, from: number, to: number, notes: NoteEvent[]) {
  const kept = part.notes.flatMap((n) => {
    if (n.start + n.duration <= from + eps || n.start >= to - eps) return [n];
    const pieces: NoteEvent[] = [];
    if (n.start < from - eps) pieces.push({ ...n, duration: from - n.start });
    if (n.start + n.duration > to + eps)
      pieces.push({ ...n, id: newId('resumed'), start: to, duration: n.start + n.duration - to });
    return pieces;
  });
  part.notes = kept.concat(notes).sort((a, b) => a.start - b.start);
}

function singLine(notes: NoteEvent[], from: number, to: number, range: number[], tempo: number) {
  const center = (range[0] + range[1]) / 2;
  const placements = [-36, -24, -12, 0, 12, 24, 36].map((shift) => ({
    shift,
    cost: notes.reduce((cost, n) => {
      const pitch = n.midi! + shift;
      return cost + Math.abs(pitch - center) * 0.04 + Math.max(0, range[0] - pitch, pitch - range[1]) * 5;
    }, 0),
  }));
  const shift = placements.sort((a, b) => a.cost - b.cost)[0].shift;
  const event: NoteEvent[] = [];
  const minSpacing = Math.max(0.25, (tempo / 60) * 0.16);
  // Match the nearest common written subdivision only when its error is within performance tolerance.
  const snap = (t: number) => {
    for (const unit of [1, 0.5, 1 / 3, 0.25]) {
      const q = Math.round(t / unit) * unit;
      if (Math.abs(t - q) <= 0.09) return q;
    }
    return Math.round(t * 24) / 24;
  };
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i],
      pitch = n.midi! + shift;
    if (pitch < range[0] || pitch > range[1]) continue;
    const t = Math.max(from, snap(n.start));
    const last = event.at(-1);
    if (last && t - last.start < minSpacing - eps) {
      // A rapid repeated pitch is a sustain or a pulse shared with the bass.
      if (last.midi === pitch)
        last.duration = Math.min(
          to - last.start,
          Math.max(last.duration, snap(n.start + n.duration) - last.start),
        );
      continue;
    }
    const next = notes[i + 1];
    const end =
      next && next.start - n.start <= 0.75 && next.start - (n.start + n.duration) < 0.34
        ? next.start
        : n.start + n.duration;
    const length = Math.min(to - t, Math.max(0.25, snap(end) - t));
    if (length < 0.24) continue;
    if (last) last.duration = Math.min(last.duration, t - last.start);
    event.push({
      id: newId('backing-line'),
      start: t,
      duration: length,
      midi: pitch,
      origin: 'arranged',
      lyric: !last || t - last.start - last.duration > 0.5 ? 'Doo' : 'oo',
      velocity: Math.min(0.82, Math.max(0.48, n.velocity)),
    });
  }
  return event;
}

/** Source-driven writing candidate. With no independent musical material, keep the current draft. */
export function writeInstrumentalLines(source: ScoreProject, previous: ScoreProject) {
  const meta = previous.arrangement;
  if (!meta || meta.options.preset !== 'solo-satb' || meta.options.transpose || meta.locks?.length)
    throw Error('此实验需要一份同调、未锁段的 Solo + SATB 草稿。');
  const lead = source.parts.find((p) => p.id === meta.options.leadPartId);
  if (!lead) throw Error('找不到源谱主旋律。');
  if (source.measures !== previous.measures || source.tempo !== previous.tempo ||
      source.timeSignature.some((value, i) => value !== previous.timeSignature[i]))
    throw Error('源谱与试听草稿的小节、拍号或速度不一致。');
  const project = structuredClone(previous);
  project.id = newId('arrangement');
  project.arrangement!.revision = (meta.revision ?? 0) + 1;
  const upper = project.parts.slice(1, 4),
    lines = backingLines(source, lead),
    bar = beatsPerBar(source);
  const gestures: Gesture[] = [];
  const solo = activeNotes(lead);
  for (const span of spansOf(source, lead)) {
    // Check instrumental answers during sung phrases locally; sustained instrumental statements stay intact.
    const window = span.sung ? bar * 2 : span.to - span.from;
    for (let from = span.from; from < span.to; from += window) {
      const to = Math.min(span.to, from + window);
      const localLead = solo.filter((n) => crosses(n, from, to));
      const choices = lines
        .map((line) => {
          const ns = line.notes.filter((n) => n.start >= from - eps && n.start < to - eps);
          const motion = new Set(ns.map((n) => n.midi)).size;
          const independent = ns.filter(
            (n) => !localLead.some((l) => Math.abs(l.start - n.start) < 0.11),
          ).length;
          return {
            line,
            ns,
            motion,
            independent,
            score: line.clarity * Math.sqrt(ns.length) * Math.min(4, motion),
          };
        })
        .filter(
          (c) =>
            c.ns.length >= 3 &&
            c.motion >= 2 &&
            (!span.sung || (c.line.clarity >= 0.82 && c.independent >= c.ns.length * 0.65)),
        )
        .sort((a, b) => b.score - a.score);
      if (!choices.length) continue;
      const { line, ns } = choices[0];
      // Keep at most one answering line under singing. Occupied, dense vocal passages retain the draft.
      if (span.sung && localLead.length / (to - from) > 1.25) continue;
      const carrier = span.sung ? upper[1] : upper[0];
      const range = span.sung ? [55, 67] : [60, 76];
      const notes = singLine(ns, from, to, range, source.tempo).filter((n) => {
        if (!span.sung) return true;
        // Protect the sustained sung pitch and surrounding voices from a new semitone rub.
        return ![...localLead, ...upper.filter((p) => p !== carrier).flatMap((p) => p.notes)].some(
          (l) =>
            crosses(l, n.start, n.start + n.duration) &&
            (semitoneClash(l.midi!, n.midi!) ||
              (upper[0].notes.includes(l) && n.midi! > l.midi!) ||
              (upper[2].notes.includes(l) && n.midi! < l.midi!)),
        );
      });
      if (notes.length < 3 || notes.length < ns.length * 0.28) continue;
      replaceSpan(carrier, from, to, notes);
      if (!span.sung) {
        // One featured line, an inner sustained harmonic guide and the existing bass.
        replaceSpan(upper[1], from, to, []);
        const guide: NoteEvent[] = [];
        for (const chord of project.chords.filter((c) => c.start < to && c.start + c.duration > from)) {
          const start = Math.max(from, chord.start, notes[0].start);
          const end = Math.min(to, chord.start + chord.duration);
          if (end <= start + eps) continue;
          const choices = chord.pitches
            .flatMap((p) => [p - 24, p - 12, p, p + 12])
            .filter(
              (p) =>
                p >= 50 &&
                p <= 60 &&
                !notes.some((n) => crosses(n, start, end) && (p >= n.midi! || semitoneClash(n.midi!, p))),
            );
          if (!choices.length) continue;
          const last = guide.at(-1),
            target = last?.midi ?? 55;
          const pitch = choices.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
          if (last && last.midi === pitch && Math.abs(last.start + last.duration - start) < eps)
            last.duration = end - last.start;
          else
            guide.push({
              id: newId('guide'),
              start,
              duration: end - start,
              midi: pitch,
              origin: 'arranged',
              velocity: 0.49,
              lyric: 'Hmm',
            });
        }
        replaceSpan(upper[2], from, to, guide);
      }
      gestures.push({
        from,
        to,
        sung: span.sung,
        carrier: carrier.id,
        source: line.source,
        attacks: notes.length,
      });
    }
  }
  for (const p of upper.filter((p) =>
    gestures.some((g) => g.carrier === p.id || (!g.sung && p === upper[2])),
  )) {
    p.notes = planVocalBreaths(p.notes, source.tempo, bar, 10, () => newId('breath'), 0.2).notes;
  }
  project.arrangement!.report = inspectArrangement(project);
  project.arrangement!.report.changes.push(
    '伴奏独立动机候选；有可用的原谱声线时交给歌手，合唱配平与换气待听评。',
  );
  const errors = validateProject(project);
  if (errors.length) throw Error(errors.join('；'));
  return { project, gestures };
}

/** Shorten a rest only with a source-supported repetition. Keep the entrance and cadence on both sides. */
export function condenseInstrumentalRepeats(source: ScoreProject, arrangement: ScoreProject) {
  const options = arrangement.arrangement?.options;
  const lead = source.parts.find((p) => p.id === options?.leadPartId);
  if (!lead || !options || arrangement.arrangement?.locks?.length)
    throw Error('需要选定主旋律并保留已认可版本。');
  const bar = beatsPerBar(source);
  const backing = source.parts.filter((p) => p !== lead && p.role !== 'percussion');
  const cells = Array.from({ length: source.measures }, () => new Set<string>());
  for (const [partIndex, part] of backing.entries())
    for (const n of activeNotes(part)) {
      const tick = Math.round(n.start * 12),
        index = Math.floor(tick / (bar * 12));
      cells[index]?.add([partIndex, tick - index * bar * 12, n.midi! % 12].join('/'));
    }
  function similarity(first: number, second: number, bars: number) {
    let score = 0;
    for (let i = 0; i < bars; i++) {
      const left = cells[first + i],
        right = cells[second + i];
      const both = [...left].filter((k) => right.has(k)).length;
      score += both / Math.max(1, left.size + right.size - both);
    }
    return score / bars;
  }
  const cuts: FormCut[] = [];
  const overview = spansOf(source, lead);
  if (activeNotes(lead).length) {
    const starts = source.parts.flatMap((p) => activeNotes(p).map((n) => n.start));
    const first = Math.floor(starts.reduce((a, b) => Math.min(a, b), Infinity) / bar);
    if (first > 0) cuts.push({ start: 0, end: first * bar });
  }
  const previous: Span[] = [];
  for (const s of overview.filter((x) => !x.sung && x.to < source.measures * bar)) {
    const first = Math.max(s.from / bar, cuts[0]?.start === 0 ? cuts[0].end / bar : 0);
    const end = s.to / bar,
      length = end - first;
    if (length >= 6) {
      const matches: Array<{ start: number; bars: number; agreement: number }> = [];
      // A returning instrumental passage can establish its identity quickly and keep its closing cadence.
      for (const p of previous) {
        if ((p.to - p.from) / bar < length) continue;
        for (let pos = p.from / bar; pos + length <= p.to / bar; pos++) {
          const agreement = similarity(pos, first, length);
          if (agreement >= 0.7) matches.push({ start: first + 1, bars: Math.floor(length / 2), agreement });
        }
      }
      // A repeated block within one introduction: remove its interior, retaining the phrase boundaries.
      for (let bars = 2; bars * 2 <= length; bars++)
        for (let pos = first; pos + 2 * bars <= end; pos++) {
          const agreement = similarity(pos, pos + bars, bars);
          if (agreement >= 0.72) matches.push({ start: pos + 1, bars, agreement });
        }
      const best = matches.sort((a, b) => b.bars - a.bars || b.agreement - a.agreement)[0];
      if (best) cuts.push({ start: best.start * bar, end: (best.start + best.bars) * bar });
    }
    previous.push(s);
  }
  const result = applyFormCuts(arrangement, cuts, { leadPartId: arrangement.parts[0].id });
  if (cuts.length) {
    result.project.id = newId('arrangement');
    const meta = structuredClone(arrangement.arrangement!);
    meta.revision = (meta.revision ?? 0) + 1;
    if (meta.plan)
      meta.plan.sections = meta.plan.sections.flatMap((section) => {
        const start = (section.startBar - 1) * bar,
          end = start + section.bars * bar;
        const portions = result.segments
          .map((s) => ({ s, a: Math.max(s.sourceStart, start), b: Math.min(s.sourceEnd, end) }))
          .filter((x) => x.a < x.b);
        if (!portions.length) return [];
        const head = portions[0];
        return [
          {
            ...section,
            startBar: 1 + (head.a - head.s.sourceStart + head.s.targetStart) / bar,
            bars: portions.reduce((n, x) => n + x.b - x.a, 0) / bar,
          },
        ];
      });
    result.project.arrangement = meta;
    meta.report = inspectArrangement(result.project);
    meta.report.changes.push('精简完整空白小节与重复伴奏；Solo 的音高、时值、字头保留，时间按原谱小节映射。');
  }
  const errors = validateProject(result.project);
  if (errors.length) throw Error(errors.join('；'));
  return result;
}
