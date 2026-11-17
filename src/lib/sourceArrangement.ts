import type { ScoreProject } from './types';
import { createMelodicDialogue } from './melodicDialogue';
import { realizeJointVoicing } from './jointVoicing';
import { extractSourceHarmony } from './sourceHarmony';
import { beatsPerBar } from './music';

/** One input-driven path for bounded Solo + SATB sketches. The original Solo
 * and ensemble come from the scaffold; only accompaniment evidence comes from
 * the reliable source. No reference arrangement or accepted excerpt is read. */
export function createSourceArrangement(
  scaffold: ScoreProject,
  reliableSource: ScoreProject,
  leadPartId: string,
  spans: Array<{ first: number; last: number }>,
) {
  const evidence = extractSourceHarmony(reliableSource, leadPartId);
  // Empty labels intentionally do not assert a guessed chord name. ChordEvent
  // here is a pitch-context adapter; the bass remains explicit in the guide.
  const context = evidence.guides.map(g => ({ start: g.start, duration: g.duration, symbol: '', pitches: [48 + g.bass, ...g.pitches.filter(p => p !== g.bass).map(p => 48 + p)] }));
  let project = structuredClone(scaffold);
  const trace = [];
  for (const span of spans) {
    const start = (span.first - 1) * beatsPerBar(project);
    const end = span.last * beatsPerBar(project);
    if (!context.some(c => c.start <= start && c.start + c.duration > start)) throw Error('Missing source harmony at excerpt start');
    // The accepted dialogue mechanism is shared by every excerpt. A section
    // label no longer raises all registers or schedules extra background attacks.
    const oldChords = project.chords;
    const dialogue = createMelodicDialogue({ ...project, chords: context }, { ...span, intent: 'conversation' }, { harmonicContext: context });
    const joint = realizeJointVoicing(dialogue.project, span, evidence.guides);
    project = joint.project;
    const cuts = [start, end];
    const split = (c: ScoreProject['chords'][number]) => {
      const ts = [c.start, ...cuts.filter(t => t > c.start && t < c.start + c.duration), c.start + c.duration].sort((a, b) => a - b);
      return ts.slice(0, -1).map((t, i) => ({ ...c, start: t, duration: ts[i + 1] - t }));
    };
    project.chords = [...oldChords.flatMap(split).filter(c => c.start < start || c.start >= end), ...context.flatMap(split).filter(c => c.start >= start && c.start < end)].sort((a, b) => a.start - b.start);
    trace.push({ span, seed: dialogue.seed, windows: dialogue.windows, gestures: dialogue.trace, voicing: joint.decisions });
  }
  return { project, evidence, trace };
}
