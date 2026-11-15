import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { analyzeHarmonyEvidence } from '../src/lib/harmonyEvidence';

const note = (midi: number, start: number, duration: number) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: 0.7 });
function fixture() {
  const p = createBlankProject(); p.measures = 2;
  p.parts = ['lead','upper','lower'].map(id=>({...structuredClone(p.parts[0]),id,notes:[]}));
  return p;
}
const analyze = (p: ReturnType<typeof fixture>) => analyzeHarmonyEvidence(p,'lead',{bassAnchors:true});
describe('harmonic bass anchors', () => {
  it('keeps a short arrival bass ahead of a later arpeggio note in the same beat', () => {
    const p=fixture(); p.parts[1].notes=[57,61,64].map(m=>note(m,0,8));
    p.parts[2].notes=[note(45,0,.5),note(43,.5,7.5)];
    expect(analyze(p).frames[0].bass).toBe(9);
  });
  it('retains supported one-beat harmonic changes instead of pooling an entire descent', () => {
    const p=fixture();
    const upper=[[60,64,67],[62,65,69],[64,67,71],[65,69,72]];
    p.parts[1].notes=upper.flatMap((ns,i)=>ns.map(m=>note(m,i,1)));
    p.parts[2].notes=[36,38,40,41].map((m,i)=>note(m,i,1));
    const chords=analyze(p).chords;
    expect(chords.map(c=>[c.start,c.duration,c.symbol])).toEqual([[0,1,'C'],[1,1,'Dm'],[2,1,'Em'],[3,1,'F']]);
  });
  it('explains an augmented dominant without inventing a perfect fifth', () => {
    const p=fixture();p.parts[1].notes=[64,68,70].map(m=>note(m,0,8));p.parts[2].notes=[note(36,0,8)];
    const result=analyze(p);expect(result.chords[0].symbol).toBe('C7#5');
    expect(result.chords[0].pitches.map(p=>p%12)).toEqual([0,4,8,10]);
  });
  it('does not turn ordinary broken-chord members into harmonic anchors', () => {
    const p=fixture();p.parts[1].notes=Array.from({length:16},(_,i)=>note([48,55,64,67][i%4],i*.5,.5));
    expect(analyze(p).chords.map(c=>c.symbol)).toEqual(['C']);
  });
  it('keeps a stable extended chord and ignores changing Solo ornaments', () => {
    const p=fixture();p.parts[1].notes=[57,59,62,66].map(m=>note(m,0,8));p.parts[2].notes=[note(43,0,8)];
    const original=analyze(p);expect(original.chords.map(c=>c.symbol)).toEqual(['Gmaj9']);
    p.parts[0].notes=Array.from({length:32},(_,i)=>note(60+i%12,i/4,.25));
    expect(analyze(p)).toEqual(original);
  });
});
