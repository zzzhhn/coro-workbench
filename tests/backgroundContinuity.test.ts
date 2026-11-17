import { describe, expect, it } from 'vitest';
import { planBackgroundContinuity } from '../src/lib/backgroundContinuity';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { createBlankProject } from '../src/lib/demo';
import { validateProject } from '../src/lib/music';
import type { ArrangementPlan, NoteEvent } from '../src/lib/types';

const n = (id: string, start: number, duration = 0.5, midi = 67): NoteEvent => ({ id, start, duration, midi, velocity: 0.7, origin: 'manual' });
const lead = [n('a', 0), n('b', 0.5), n('c', 1, 1), n('d', 3, 2), n('e', 5, 1), n('f', 7, 2)];
const plan: ArrangementPlan = { version: 2, planner: 'manual', ensemble: 'solo+satb', sections: [
  { id: 'one', label: 'One', kind: 'verse', startBar: 1, bars: 4, energy: 3, texture: 'rhythm', bass: 'pulse' },
] };
const chords = [0, 4, 8, 12].map(start => ({ start, end: start + 4 }));
const run = (notes = lead, p = plan) => planBackgroundContinuity(notes, p, chords, 80, 4, 16);

describe('cross-phrase background tasks', () => {
  it('continues the motif clock through a short breath instead of restarting on the next phrase', () => {
    const result = run();
    const motion = result.attacks.filter(a => a.role === 'motion');
    expect(motion.map(a => a.start)).toEqual([0, 0.5, 1, 4, 4.5, 5, 8, 8.5]);
    expect(motion.some(a => a.start === 3)).toBe(false);
    expect(result.tasks.filter(t => t.role === 'motion')).toHaveLength(1);
    expect(result.tasks.find(t => t.role === 'support')?.start).toBe(3);
  });
  it('retains source-specific rhythm without note-id or song-name templates', () => {
    const changed = lead.map(note => note.id === 'b' ? { ...note, start: 1.5 } : note);
    expect(run(changed).motifs[0].hits.map(h => h.offset)).not.toEqual(run().motifs[0].hits.map(h => h.offset));
    const strip = (notes: NoteEvent[]) => run(notes).attacks.map(({ sourceIds: _, ...hit }) => hit);
    expect(strip(lead.map((note, i) => ({ ...note, id: String(i) })))).toEqual(strip(lead));
    // A later phrase changes; the established first motif still spans the breath.
    expect(run(lead.map(note => note.id === 'd' ? { ...note, start: 3.5, duration: 1.5 } : note))
      .attacks.filter(a => a.role === 'motion')).toEqual(run().attacks.filter(a => a.role === 'motion'));
  });
  it('does not restart when an identical plan is split at an arbitrary bar', () => {
    const split = structuredClone(plan);
    split.sections = [{ ...plan.sections[0], bars: 2 }, { ...plan.sections[0], id: 'two', startBar: 3, bars: 2 }];
    expect(run(lead, split)).toEqual(run());
  });
  it('ends motion at a long silence and keeps response notes out of the next solo phrase', () => {
    const result = run([n('a', 0), n('b', 0.5), n('c', 1, 1), n('d', 8), n('e', 9, 2)]);
    expect(result.tasks.filter(t => t.role === 'motion')).toHaveLength(2);
    expect(result.attacks.filter(a => a.role === 'motion').some(a => a.start >= 2 && a.start < 8)).toBe(false);
    const answers = run().attacks.filter(a => a.role === 'answer');
    expect(answers.every(a => !lead.some(note => note.start < a.start + a.duration && note.start + note.duration > a.start))).toBe(true);
    expect(run([]).attacks.every(a => a.voice === 'B' && a.role === 'foundation')).toBe(true);
  });
  it('allocates movement by register clearance rather than making Tenor the permanent pad', () => {
    const highLead = run(lead.map(note => ({ ...note, midi: 76 }))).tasks.find(t => t.role === 'motion');
    const lowLead = run(lead.map(note => ({ ...note, midi: 52 }))).tasks.find(t => t.role === 'motion');
    expect(highLead?.voice).toBe('T'); expect(lowLead?.voice).toBe('S');
  });
  it('does not inherit a sixteenth pickup as a permanent off-grid background clock', () => {
    const result = run(lead.map(note => ({ ...note, start: note.start + 0.25 })));
    expect(result.attacks.length).toBeGreaterThan(0);
    expect(result.attacks.every(a => Number.isInteger(a.start * 2) && Number.isInteger(a.duration * 2))).toBe(true);
    expect(result.attacks.filter(a => a.role === 'motion').map(a => a.start)).toContain(4.5);
  });
  it.each([3, 4])('preserves source, Solo, ensemble and valid monophonic output in %s/4', meter => {
    const source = createBlankProject();
    source.measures = 4; source.timeSignature = [meter, 4]; source.parts[0].notes = lead;
    source.chords = [{ start: 0, duration: meter * 4, symbol: 'C', pitches: [48, 52, 55] }];
    const before = structuredClone(source);
    const options = { preset: 'solo-satb' as const, transpose: 0, style: 'pop' as const,
      difficulty: 'medium' as const, percussion: false, leadPartId: source.parts[0].id };
    const old = arrangeV2(source, options, plan, 'phrase');
    const result = arrangeV2(source, options, plan, 'continuity');
    const semantic = (notes: NoteEvent[]) => notes.map(({ id: _, ...note }) => note);
    expect(source).toEqual(before);
    expect(semantic(result.parts[0].notes)).toEqual(semantic(old.parts[0].notes));
    expect(result.parts.map(p => [p.id, p.name, p.instrument, p.program, p.volume, p.pan])).toEqual(
      old.parts.map(p => [p.id, p.name, p.instrument, p.program, p.volume, p.pan]));
    expect(result.chords).toEqual(old.chords); expect(result.tempo).toBe(old.tempo);
    expect(validateProject(result)).toEqual([]);
    for (const part of result.parts.slice(1)) for (let i = 0; i < part.notes.length; i++) {
      const note = part.notes[i];
      expect(note.duration).toBeGreaterThan(0);
      expect(note.start + note.duration).toBeLessThanOrEqual(meter * 4 + 1e-6);
      if (i) expect(part.notes[i - 1].start + part.notes[i - 1].duration).toBeLessThanOrEqual(note.start + 1e-6);
    }
  });
});
