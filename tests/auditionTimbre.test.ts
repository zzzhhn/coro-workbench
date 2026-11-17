import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { auditionPart, auditionProject } from '../src/lib/auditionTimbre';
import { sampleBankFor } from '../src/lib/audio';

describe('background audition timbre', () => {
  it('defaults vocal backing to piano samples without changing Solo, score or mix', () => {
    const p = createBlankProject(), part = p.parts[0];
    p.parts = ['lead', 'harmony', 'harmony', 'harmony', 'bass'].map((role, i) => ({
      ...structuredClone(part), id: String(i), role: role as typeof part.role,
      instrument: 'choir_aahs', program: 52, solo: i === 2,
      notes: [{ id: String(i), midi: 60+i, start: 0, duration: 1, lyric: 'Ooh', velocity: 0.6 }],
    }));
    const saved = structuredClone(p), view = auditionProject(p);
    expect(view.parts.map(sampleBankFor)).toEqual(['choir_aahs', ...Array(4).fill('acoustic_grand_piano')]);
    expect(view.parts[0]).toBe(p.parts[0]);
    expect(p).toEqual(saved);
    view.parts.forEach((v, i) => { const { program, instrument, ...actual } = v; const { program: a, instrument: b, ...before } = p.parts[i]; expect(actual).toEqual(before); });
    expect(auditionProject(p, 'original')).toBe(p);
  });
  it('does not turn source instruments, percussion or named Solo into piano', () => {
    const part = createBlankProject().parts[0];
    for (const patch of [
      { role: 'instrument', instrument: 'violin', program: 40 },
      { role: 'bass', instrument: 'acoustic_bass', program: 32 },
      { role: 'percussion', instrument: 'voice percussion', program: 54 },
      { id: 'solo', role: 'harmony', instrument: 'choir_aahs', program: 52 },
    ] as const) { const p = { ...part, ...patch }; expect(auditionPart(p)).toBe(p); }
  });
});
