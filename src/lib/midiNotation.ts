import type { ScoreProject } from './types';

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
