import { expect, it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { createSourceChant } from '../src/lib/sourceChant';
const n = (midi: number, start = 0, duration = 4) => ({ id: `${midi}-${start}`, midi, start, duration, velocity: .6 });
function fixture() {
  const source = createBlankProject(); source.measures = 8;
  const template = source.parts[0];
  source.parts = [{ ...structuredClone(template), id: 'upper', notes: [n(60), n(64), n(67)] }, { ...structuredClone(template), id: 'lower', notes: [n(36)] }];
  const scaffold = structuredClone(source);
  scaffold.parts = ['solo', 'voice-s', 'voice-a', 'voice-t', 'voice-b'].map(id => ({ ...structuredClone(template), id, notes: [n(60, 0, 4), n(67, 16, 4)] }));
  return { source, scaffold };
}
const selection = { accompanimentIds: ['upper', 'lower'], bassPartId: 'lower' };
it('holds source harmony through a single-note piano fill without copying its rhythm', () => {
  const { source, scaffold } = fixture();
  source.parts[0].notes = [...[60,64,67].map(m => n(m, 0, 1)), ...[72,74,76,77].map((m,i) => n(m, 1+i*.25,.25)), ...[60,64,67].map(m => n(m, 2, 1))];
  const r = createSourceChant(scaffold, source, selection, [{ first: 1, last: 1 }]);
  expect(r.anchors).toHaveLength(1);
  r.project.parts.slice(1).forEach(p => { expect(p.notes.filter(x => x.start < 4)).toHaveLength(1); expect(p.notes[0].duration).toBe(4); });
  expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
});
it('keeps genuine half-beat block changes instead of deleting all short harmony', () => {
  const { source, scaffold } = fixture();
  source.parts[0].notes = [...[60,64,67].map(m => n(m, 0, 1.5)), ...[62,65,69].map(m => n(m, 1.5,.5)), ...[60,64,67].map(m => n(m, 2,2))];
  source.parts[1].notes = [n(36,0,1.5),n(38,1.5,.5),n(36,2,2)];
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:1}]);
  expect(r.anchors.map(g=>g.start)).toEqual([0,1.5,2]); expect(r.anchors[1].bass).toBe(2);
});
it('preserves a fresh bass anchor rather than the previous overlapping low note', () => {
  const { source, scaffold } = fixture();
  source.parts[0].notes=[...[60,64,67].map(m=>n(m,0,2)),...[62,66,69].map(m=>n(m,2,2))];
  source.parts[1].notes=[n(36,0,3),n(43,2,2)];
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:1}]);
  expect(r.anchors[1].bass).toBe(7);
  expect(r.project.parts[4].notes.find(x=>x.start===2)!.midi!%12).toBe(7);
});
it('reduces a five-tone source to an existing upper triad and bass in every key', () => {
  for(let shift=0;shift<12;shift++){
    const {source,scaffold}=fixture();source.parts[0].notes=[57,61,62,66].map(m=>n(m+shift));source.parts[1].notes=[n(47+shift)];
    const r=createSourceChant(scaffold,source,selection,[{first:1,last:1}]);
    expect(new Set(r.anchors[0].upper.map(m=>m%12))).toEqual(new Set([57,62,66].map(m=>(m+shift)%12)));
    expect(r.anchors[0].omitted).toEqual([(61+shift)%12]);
  }
});
it('does not turn upper bass-staff arpeggio tones into bass changes', () => {
  const {source,scaffold}=fixture();source.parts[1].notes=[n(36,0,.5),n(43,.5,.5),n(55,1,1),n(36,2,2)];
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:1}]);
  expect(r.anchors.map(g=>g.bass)).toEqual([0]);
});
it('respects source silence and adds explicit breathing space in continuous phrases', () => {
  const {source,scaffold}=fixture();source.parts.forEach(p=>p.notes=p.notes.map(x=>({...x,duration:16})));
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:4}]);
  expect(r.breaths.length).toBeGreaterThan(0);
  const breath=r.breaths[0];r.project.parts.slice(1).forEach(p=>expect(p.notes.some(x=>x.start<breath.end&&x.start+x.duration>breath.start)).toBe(false));
  r.project.parts.slice(1).forEach((p,i)=>expect(p.notes.filter(x=>x.start>=16)).toEqual(scaffold.parts[i+1].notes.filter(x=>x.start>=16)));
  source.parts.forEach(p=>p.notes=p.notes.map(x=>({...x,duration:1})));
  const q=createSourceChant(scaffold,source,selection,[{first:1,last:1}]);
  q.project.parts.slice(1).forEach(p=>expect(p.notes.filter(x=>x.start<4).every(x=>x.start+x.duration<=1)).toBe(true));
});
it('places a breath before short cadence chords rather than erasing them', () => {
  const {source,scaffold}=fixture();
  source.parts[0].notes=[...[60,64,67].map(m=>n(m,0,7)),...[62,65,69].map(m=>n(m,7,.5)),...[64,68,71].map(m=>n(m,7.5,.5)),...[60,64,67].map(m=>n(m,8,4))];
  source.parts[1].notes=[n(36,0,7),n(38,7,.5),n(40,7.5,.5),n(36,8,4)];
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:3}]);
  for(const t of [7,7.5]) expect(r.project.parts.slice(1).every(p=>p.notes.some(n=>n.start<=t+1e-6&&n.start+n.duration>=t+.5-1e-6))).toBe(true);
});
it('lets a Solo pickup lead into the next bar instead of tying the backing through it', () => {
  const {source,scaffold}=fixture();source.parts.forEach(p=>p.notes=p.notes.map(n=>({...n,duration:8})));
  scaffold.parts[0].notes=[n(60,0,3),n(62,3.75,.25),n(64,4,4)];
  const r=createSourceChant(scaffold,source,selection,[{first:1,last:2}]);
  expect(r.breaths).toContainEqual({start:3.5,end:4});
  r.project.parts.slice(1).forEach(p=>expect(p.notes.some(n=>n.start<4&&n.start+n.duration>3.5)).toBe(false));
  expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
});
