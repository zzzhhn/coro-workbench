import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { createSourceChant } from '../src/lib/sourceChant';
const n = (midi: number, start: number, duration: number) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: .48 });
function fixture(shift = 0) {
  const source = createBlankProject(); source.measures = 4;
  const part = source.parts[0];
  source.parts = [
    { ...part, id: 'upper', notes: [62, 69, 74, 78].map((m,i) => n(m + shift, 2 + i / 2, .5)) },
    { ...part, id: 'low', notes: [38, 45, 52, 54].map((m,i) => n(m + shift, i / 2, .5)) },
  ];
  const scaffold = structuredClone(source);
  scaffold.parts = ['solo','voice-s','voice-a','voice-t','voice-b'].map(id => ({ ...part, id, notes: [n(60, 8, 4)] }));
  return { source, scaffold };
}
const selection = { accompanimentIds: ['upper','low'], bassPartId: 'low' };
const options = { harmony: 'vocal-core' as const, recoverInstrumentalArpeggios: true };
it('recovers a source-supported instrumental arpeggio in every key without its eighth-note attacks', () => {
  for (let shift = 0; shift < 12; shift++) {
    const {source, scaffold} = fixture(shift);
    const r = createSourceChant(scaffold, source, selection, [{first:1,last:1}], options);
    expect(r.anchors[0].reason).toBe('instrumental-arpeggio');
    expect(r.anchors[0].bass).toBe((2 + shift) % 12);
    expect(new Set(r.slices[0].voicing.map(m => (m - shift + 120) % 12))).toEqual(new Set([2,6,9]));
    r.project.parts.slice(1).forEach(p => expect(p.notes.filter(n => n.start < 4)).toHaveLength(1));
    expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
  }
});
it('uses only accompaniment evidence, preserves overlapping Solo, and does not harmonize a scale', () => {
  const {source,scaffold} = fixture();
  scaffold.parts[0].notes = [n(62,0,4)];
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:1}],options);
  expect(r.anchors[0].reason).toBe('instrumental-arpeggio');
  expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
  scaffold.parts[0].notes = [];
  source.parts[0].notes = [60,62,64,65,67,69,71,72].map((m,i)=>n(m,i/2,.5)); source.parts[1].notes = [];
  expect(createSourceChant(scaffold,source,selection,[{first:1,last:1}],options).anchors).toHaveLength(0);
});
it('replaces stale upper harmony over a fresh arpeggiated bass without changing a real block chord', () => {
  const {source,scaffold}=fixture();
  source.parts.forEach(p=>p.notes=p.notes.map(n=>({...n,start:n.start+4})));
  source.parts[0].notes.unshift(...[58,62,67].map(m=>n(m,0,4)));
  source.parts[1].notes.unshift(n(43,0,4));
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:2}],options);
  expect(r.anchors[0].reason).toBe('chord-arrival');
  expect(r.anchors[1].reason).toBe('instrumental-arpeggio');
  expect(new Set([r.anchors[1].bass,...r.anchors[1].upper.map(m=>m%12)])).toEqual(new Set([2,6,9]));
});
it('ends an exposed octave unison on its actual pitch class without inventing a triad', () => {
  const {source,scaffold} = fixture(); source.parts[0].notes = [n(86,0,3.875),n(98,.125,3.75)]; source.parts[1].notes=[];
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:1}],options);
  expect(r.anchors[0].reason).toBe('octave-unison');
  expect(new Set(r.slices[0].voicing.map(m=>m%12))).toEqual(new Set([2]));
  expect(r.slices[0].duration).toBe(4);
  expect(source.parts[0].notes[0].duration).toBe(3.875);
});
