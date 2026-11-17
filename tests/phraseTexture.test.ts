import { describe, expect, it } from 'vitest';
import { phraseTexture } from '../src/lib/phraseTexture';
import { arrangeV2 } from '../src/lib/arrangeV2';
import { createBlankProject } from '../src/lib/demo';
import { validateProject } from '../src/lib/music';
import type { ArrangementOptions, ArrangementSectionPlan, NoteEvent } from '../src/lib/types';
const note = (id: string, start: number, duration: number): NoteEvent => ({ id, midi: 67, start, duration, velocity: 0.7, origin: 'manual' });
const section: ArrangementSectionPlan = { id: 's', label: 'Test', kind: 'chorus', startBar: 1, bars: 4, energy: 4, texture: 'rhythm', bass: 'groove' };
const chords = [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 12 }, { start: 12, end: 16 }];
const lead = [note('a', 0, 1), note('b', 1, 0.5), note('c', 1.5, 2.5), note('d', 6, 2), note('e', 8, 3)];
const schedule = (notes = lead, a = 0, b = 16) => phraseTexture(notes, section, a, b, chords, 80);

describe('phrase-based background scheduling', () => {
  it('answers in a real gap and withdraws that answer when the singer fills it', () => {
    const answers = schedule().filter(e => e.reason === 'gap-response' && e.start >= 4 && e.start < 6);
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every(e => e.start + e.duration <= 6)).toBe(true);
    expect(schedule([...lead, note('fill', 4, 2)]).filter(e => e.reason === 'gap-response' && e.start >= 4 && e.start < 6)).toEqual([]);
  });
  it('adapts motion to changed source rhythm, independently of pitch and note ids', () => {
    const shifted = lead.map(n => n.id === 'b' ? { ...n, start: 0.5, duration: 1 } : n);
    expect(schedule(shifted).filter(e => e.voice === 'A')).not.toEqual(schedule().filter(e => e.voice === 'A'));
    expect(schedule(lead.map(n => ({ ...n, midi: n.midi! + 2 })))).toEqual(schedule());
    expect(schedule().every(e => e.sourceIds.length || e.reason === 'harmonic-entry')).toBe(true);
  });
  it('writes background spans between selected anchors even when the solo uses short notes', () => {
    const rapid = Array.from({ length: 16 }, (_, i) => note('rapid-' + i, i / 4, 0.25));
    const alto = schedule(rapid).filter(e => e.voice === 'A');
    expect(alto).toHaveLength(8);
    expect(alto.map(e => e.duration)).toEqual(Array(8).fill(0.5));
    expect(alto.reduce((sum,e) => sum + e.duration, 0)).toBe(4);
  });
  it('uses global phrase boundaries when a section begins during a sustained note', () => {
    const notes = [note('long', 0, 8), note('next', 10, 3)];
    const partial = schedule(notes, 4, 8);
    expect(partial.some(e => e.voice === 'T' && e.start === 4 && e.duration === 4)).toBe(true);
    expect(partial.every(e => e.start >= 4 && e.start + e.duration <= 8)).toBe(true);
    expect(partial.filter(e => e.reason === 'gap-response')).toEqual([]);
  });
  it('keeps a bass anchor after rejecting an intervening close chord boundary', () => {
    const hits = phraseTexture([note('a',0,0.5),note('b',0.5,1.5)],section,0,4,
      [{start:0,end:0.25},{start:0.25,end:4}],80);
    expect(hits.filter(e=>e.voice==='B').map(e=>e.start)).toEqual([0,0.5]);
  });
  it('has no clocked pattern in an instrumental passage and handles empty input', () => {
    expect(schedule([]).map(e => e.voice)).toEqual(['B','T','B','T','B','T','B','T']);
    expect(schedule([]).every(e => e.reason === 'harmonic-entry')).toBe(true);
  });
  it.each([3, 4])('preserves Solo and produces valid monophonic backgrounds in %s/4', meter => {
    const source = createBlankProject();
    source.measures = 4; source.timeSignature = [meter, 4];
    source.parts[0].notes = lead.map(n => ({ ...n, lyric: n.id }));
    source.chords = [{ start: 0, duration: meter * 4, symbol: 'C', pitches: [48, 52, 55] }];
    const before = structuredClone(source);
    const options: ArrangementOptions = { preset: 'solo-satb', transpose: 0, style: 'pop', difficulty: 'medium', percussion: false, leadPartId: source.parts[0].id };
    const plan = { version: 2 as const, planner: 'rule' as const, ensemble: 'solo+satb' as const, sections: [section] };
    const candidate = arrangeV2(source, options, plan, 'phrase');
    expect(source).toEqual(before);
    const semantic = (notes: NoteEvent[]) => notes.map(({ id: _id, ...n }) => n);
    expect(semantic(candidate.parts[0].notes)).toEqual(semantic(source.parts[0].notes));
    expect(validateProject(candidate)).toEqual([]);
    for (const part of candidate.parts.slice(1)) {
      for (let i = 0; i < part.notes.length; i++) {
        const n = part.notes[i];
        expect(n.duration).toBeGreaterThan(0);
        expect(n.start + n.duration).toBeLessThanOrEqual(meter * 4 + 1e-6);
        if (i) expect(part.notes[i-1].start + part.notes[i-1].duration).toBeLessThanOrEqual(n.start + 1e-6);
      }
    }
    const defaultResult = arrangeV2(source, options, plan);
    const explicitLegacy = arrangeV2(source, options, plan, 'legacy');
    expect(defaultResult.parts.map(p => semantic(p.notes))).toEqual(explicitLegacy.parts.map(p => semantic(p.notes)));
  });
});
