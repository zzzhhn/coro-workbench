import type { NoteEvent, ScoreProject } from './types';

const EPSILON = 1e-6;
// Written values Coro can engrave without inventing tuplets: 32nds plus eighth-note triplets.
const WRITTEN_UNITS = [1 / 8, 1 / 6];
const MAX_GATE_LOSS = 0.075;

export interface MidiNotationReport {
  detected: boolean;
  gateRatio: number | null;
  support: number;
  restoredDurations: number;
  snappedOnsets: number;
  globalOnsetShift: number;
  unchanged: number;
}

function writtenCandidates(duration: number): number[] {
  const values = WRITTEN_UNITS.flatMap((unit) => {
    const first = Math.ceil((duration - EPSILON) / unit);
    return [first, first + 1].map((count) => count * unit);
  });
  return [...new Set(values.map((value) => Number(value.toFixed(9))))].sort((a, b) => a - b);
}

function nearestGrid(value: number): number {
  const straight = Math.round(value * 8) / 8;
  const triplet = Math.round(value * 12) / 12;
  return Math.abs(straight - value) <= Math.abs(triplet - value) ? straight : triplet;
}

function nearestWritten(value: number): number {
  const straight = Math.round(value * 8) / 8;
  const triplet = Math.round(value * 6) / 6;
  return Math.abs(straight - value) <= Math.abs(triplet - value) ? straight : triplet;
}

/** Some exports delay every event by a few ticks; remove only a shared, dominant offset. */
function dominantOnsetShift(project: ScoreProject): number {
  const residues = new Map<string, number>();
  const notes = project.parts.flatMap((part) => part.notes.filter((note) => note.midi !== null));
  for (const note of notes) {
    const residue = note.start - Math.floor(note.start * 48 + EPSILON) / 48;
    if (residue < 0.003 || residue > 0.018) continue;
    const key = residue.toFixed(4);
    residues.set(key, (residues.get(key) ?? 0) + 1);
  }
  const [best, count] = [...residues].sort((a, b) => b[1] - a[1])[0] ?? ['0', 0];
  return count >= Math.max(12, notes.length * 0.35) ? Number(best) : 0;
}

/** Detect notation-software MIDI gates (for example Crescendo's ~95% note length). */
export function detectMidiGate(project: ScoreProject): { ratio: number | null; support: number } {
  const notes = project.parts
    .filter((part) => part.role !== 'percussion')
    .flatMap((part) => part.notes.filter((note) => note.midi !== null));
  const ratios = notes.flatMap((note) => {
    const written = writtenCandidates(note.duration)[0];
    const ratio = note.duration / written;
    return ratio > 0.8 && ratio < 0.995 ? [ratio] : [];
  });
  if (ratios.length < Math.max(8, notes.length * 0.45)) return { ratio: null, support: ratios.length / Math.max(1, notes.length) };
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  const support = ratios.filter((ratio) => Math.abs(ratio - median) <= 0.006).length / notes.length;
  return { ratio: support >= 0.45 ? median : null, support };
}

/**
 * Restore written MIDI durations only when the file has one dominant export gate.
 * Free-length performances are left untouched; repeated attacks are never extended across.
 */
export function normalizeMidiNotation(project: ScoreProject): MidiNotationReport {
  const { ratio, support } = detectMidiGate(project);
  const report: MidiNotationReport = {
    detected: ratio !== null,
    gateRatio: ratio,
    support,
    restoredDurations: 0,
    snappedOnsets: 0,
    globalOnsetShift: 0,
    unchanged: 0,
  };
  if (ratio === null) return report;
  const shift = dominantOnsetShift(project);
  if (shift) {
    report.globalOnsetShift = shift;
    for (const part of project.parts)
      for (const note of part.notes)
        if (note.start >= shift - EPSILON) note.start = Math.max(0, note.start - shift);
  }
  for (const part of project.parts) {
    if (part.role === 'percussion') continue;
    for (const note of part.notes) {
      if (note.midi === null) continue;
      const snapped = nearestGrid(note.start);
      if (Math.abs(snapped - note.start) > EPSILON && Math.abs(snapped - note.start) <= 0.008) {
        note.duration += note.start - snapped;
        note.start = snapped;
        report.snappedOnsets++;
      }
    }
    const pitched = part.notes.filter((note) => note.midi !== null).sort((a, b) => a.start - b.start);
    for (const note of pitched) {
      const exact = nearestWritten(note.duration);
      if (exact > 0 && Math.abs(exact - note.duration) <= 0.0065) {
        if (Math.abs(exact - note.duration) > EPSILON) report.restoredDurations++;
        note.duration = exact;
        continue;
      }
      const written = writtenCandidates(note.duration).find(
        (value) =>
          value - note.duration > EPSILON &&
          value - note.duration <= Math.min(value * MAX_GATE_LOSS, 0.25) + 0.0015,
      );
      if (written === undefined) {
        report.unchanged++;
        continue;
      }
      const nextSame = pitched.find(
        (other) => other !== note && other.midi === note.midi && other.start > note.start + EPSILON,
      );
      if (nextSame && note.start + written > nextSame.start + EPSILON) {
        report.unchanged++;
        continue;
      }
      note.duration = written;
      report.restoredDurations++;
    }
  }
  project.source.analysis ??= { transforms: [] };
  project.source.analysis.transforms.push('midi-notation-gate-restore');
  project.source.analysis.quality = {
    ...project.source.analysis.quality,
    'midi.gateRatio': Number(ratio.toFixed(5)),
    'midi.gateSupport': Number(support.toFixed(4)),
    'midi.restoredDurations': report.restoredDurations,
    'midi.snappedOnsets': report.snappedOnsets,
    'midi.globalOnsetShift': Number(shift.toFixed(5)),
  };
  project.source.warnings.push(
    `检测到导出软件约 ${(ratio * 100).toFixed(1)}% 的统一 MIDI 时值门限：已恢复 ${report.restoredDurations} 个书面时值、对齐 ${report.snappedOnsets} 个微小起音偏移${shift ? `、移除全曲共同的 ${shift.toFixed(4)} 拍延迟` : ''}；${report.unchanged} 个不符合规律的音保留原样。`,
  );
  return report;
}

const MAX_ONSET_DELAY = 1 / 80;
const MAX_CLOCK_OFFSET = 1 / 10;
const MAX_ATTACK_JITTER = 1 / 240;
const MAX_GATE_OVERLAP = 1 / 8 + MAX_ATTACK_JITTER;
const SHORT_GATE_GAP = 1 / 16;

function commonPhase(notes: NoteEvent[], subdivisions: number, maxOffset: number, support: number): number | undefined {
  const residuals = notes
    .map(({ start }) => start - Math.round(start * subdivisions) / subdivisions)
    .filter((residue) => Math.abs(residue) <= maxOffset)
    .sort((a, b) => a - b);
  if (residuals.length < notes.length * support) return;
  const phase = residuals[Math.floor(residuals.length / 2)];
  return residuals.filter((residue) => Math.abs(residue - phase) <= MAX_ATTACK_JITTER + EPSILON).length
    >= notes.length * support ? phase : undefined;
}

function writtenGate(duration: number): boolean {
  const tripletUnits = Math.round(duration * 12);
  return Math.abs(duration - Math.round(duration * 16) / 16) < EPSILON ||
    (Number.isInteger(Math.log2(tripletUnits)) && Math.abs(duration - tripletUnits / 12) < EPSILON);
}

function measuredPhase(notes: NoteEvent[]): number | undefined {
  // A small common offset is common in MIDI exports. A larger offset needs a
  // nearly unanimous 16th-note clock, and must itself be off the written grid.
  const smallDelay = commonPhase(notes, 8, MAX_ONSET_DELAY, 0.75);
  if (smallDelay !== undefined || notes.length < 12) return smallDelay;
  const clockOffset = commonPhase(notes, 4, MAX_CLOCK_OFFSET, 0.95);
  return clockOffset !== undefined && !writtenGate(Math.abs(clockOffset)) ? clockOffset : undefined;
}

/** Infer a readable written rhythm for a measured, monophonic MIDI Solo.
 * Feed the derived copy to engraving/export only. IDs, pitches and all non-Solo
 * parts are shared with the arrangement, whose measured playback stays intact.
 */
export function projectMeasuredSoloNotation(project: ScoreProject): ScoreProject {
  if (project.source.kind !== 'midi' || !project.arrangement) return project;
  const solo = project.parts.find((part) => part.id === 'solo' && part.role === 'lead');
  if (!solo || solo.notes.length < 8 || solo.staves?.length || solo.pedals?.length || solo.pedalSustain?.length ||
    solo.notes.some((note) => note.midi === null || note.voice || note.staff || note.arpeggio)) return project;

  const notes = [...solo.notes].sort((a, b) => a.start - b.start);
  const phase = measuredPhase(notes);
  if (phase === undefined) return project;
  const barLength = (project.timeSignature[0] * 4) / project.timeSignature[1];
  const scoreEnd = barLength * project.measures;
  const gridAttacks = notes.map(({ start }) => {
    const shifted = start - phase;
    const grid = nearestGrid(shifted);
    return grid >= 0 && grid < scoreEnd && Math.abs(shifted - grid) <= MAX_ATTACK_JITTER + EPSILON ? grid : undefined;
  });
  const attacks = gridAttacks.map((grid, index) => grid ?? notes[index].start);
  // Coincident attacks and longer overlaps may be independent written voices.
  // Bypass a part if the grid would collapse attacks or the source is polyphonic.
  if (notes.some((note, index) => index > 0 && (
    attacks[index] - attacks[index - 1] <= EPSILON ||
    notes[index - 1].start + notes[index - 1].duration - note.start > MAX_GATE_OVERLAP + EPSILON
  ))) return project;

  const changed = new Map<NoteEvent, NoteEvent>();
  notes.forEach((note, index) => {
    const start = attacks[index];
    const next = attacks[index + 1] ?? scoreEnd;
    const end = start + note.duration;
    const previous = notes[index - 1];
    const clippedReattack = previous?.midi === note.midi && next - start >= 1 / 4 - EPSILON &&
      Math.abs(previous.start + previous.duration - note.start - note.duration) <= MAX_ATTACK_JITTER;
    const overlaps = end > next + EPSILON && Math.abs(phase) > EPSILON;
    let duration = start === note.start ? note.duration : Math.min(note.duration, scoreEnd - start);
    if (gridAttacks[index] !== undefined && (index + 1 === notes.length || gridAttacks[index + 1] !== undefined) &&
      !note.articulation && (overlaps || !writtenGate(duration)) && (duration >= SHORT_GATE_GAP || clippedReattack)) {
      if (end >= next - SHORT_GATE_GAP) {
        // Clip measured legato overlaps and close residual note-off gaps.
        duration = next - start;
      } else {
        const barline = Math.round(end / barLength) * barLength;
        if (barline > start && barline <= next && Math.abs(barline - end) <= SHORT_GATE_GAP) {
          duration = barline - start;
        } else if (Math.abs(start * 8 - Math.round(start * 8)) < EPSILON) {
          // Keep longer silences and turn performed straight gates into readable
          // 16ths (or 32nds for short notes). Triplet attacks keep their clock.
          const unit = duration < 1 / 4 ? 1 / 8 : 1 / 4;
          const minRest = next - end >= 1 / 8 - MAX_ATTACK_JITTER ? 1 / 8 : 0;
          duration = Math.min(next - start - minRest, Math.max(1, Math.round(duration / unit)) * unit);
        }
      }
    }
    if (Math.abs(start - note.start) > EPSILON || Math.abs(duration - note.duration) > EPSILON)
      changed.set(note, { ...note, start, duration });
  });
  if (!changed.size) return project;
  return {
    ...project,
    parts: project.parts.map((part) => part === solo
      ? { ...solo, notes: solo.notes.map((note) => changed.get(note) ?? note) }
      : part),
  };
}
