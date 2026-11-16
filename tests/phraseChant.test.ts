import { expect, it } from 'vitest';
import { planPhraseChant } from '../src/lib/phraseChant';
import { createSourceChant, type ChantAnchor } from '../src/lib/sourceChant';
import { createBlankProject } from '../src/lib/demo';
const anchor = (start: number, duration: number): ChantAnchor => ({ start, duration, bass: 0,
  upper: [60, 64, 67], sourceUpper: [60, 64, 67], omitted: [], sourceNoteIds: ['source'], reason: 'chord-arrival' });
const coverage = [{ start: 0, end: 16 }];

it('chooses one pulse across a four-bar block rather than changing it each bar', () => {
  const r = planPhraseChant([anchor(0, 4), anchor(4, 2), anchor(6, 2), anchor(8, 3), anchor(11, 5)], coverage, coverage, 4, 65);
  expect(r.blocks.map(b => b.pulse)).toEqual([1]);
  const rhythm = (bar: number) => r.events.filter(e => e.start >= bar * 4 && e.start < (bar + 1) * 4)
    .map(e => [e.start % 4, e.end - e.start]);
  for (let bar = 1; bar < 4; bar++) expect(rhythm(bar)).toEqual(rhythm(0));
  expect(r.events.map(e => e.anchor.start)).toContain(11);
});
it('uses slower pulses when the source supports them, not a fixed quarter-note template', () => {
  expect(planPhraseChant([anchor(0,16)],coverage,coverage,4,65).blocks[0].pulse).toBe(4);
  expect(planPhraseChant([anchor(0,2),anchor(2,14)],coverage,coverage,4,65).blocks[0].pulse).toBe(2);
});
it('keeps short off-grid harmonies and discloses the rhythm/breath exception', () => {
  const r=planPhraseChant([anchor(0,3.5),anchor(3.5,.5),anchor(4,12)],coverage,coverage,4,65);
  expect(r.events.some(e=>e.start===3.5&&e.end===4)).toBe(true);
  expect(r.blocks[0].exceptions).toContainEqual({start:3.5,reason:'off-grid-harmony'});
  expect(r.blocks[0].exceptions).toContainEqual({start:3.5,reason:'breath-conflicts-with-harmony'});
});
it('does not carry an old harmony across source silence or insert missing notes', () => {
  const r=planPhraseChant([anchor(0,8),anchor(8,8)],[{start:0,end:2},{start:5,end:16}],coverage,4,65);
  expect(r.events.some(e=>e.start<8&&e.end>2)).toBe(false);
  expect(r.events.some(e=>e.start===8)).toBe(true);
});
it('supports triple meter and tempo-dependent breathing', () => {
  const span=[{start:0,end:12}];
  const r=planPhraseChant([anchor(0,12)],span,span,3,120);
  expect(r.blocks[0].pulse).toBe(3);expect(r.blocks[0].breathEveryBars).toBe(4);
  expect(r.breaths).toEqual([{start:11.5,end:12}]);
  expect(()=>planPhraseChant([],span,span,3,120,2)).toThrow();
});
it('applies the rhythm to all four actual parts while preserving Solo and other passages', () => {
  const source=createBlankProject();source.measures=8;source.tempo=65;
  const template=source.parts[0];
  const n=(midi:number,start:number,duration:number)=>({id:`${midi}-${start}`,midi,start,duration,velocity:.5});
  source.parts=[{...template,id:'upper',notes:[0,4,6,8,11].flatMap((t,i)=>[60,64,67].map(m=>n(m,t,([4,6,8,11,16][i])-t)))},
    {...template,id:'bass',notes:[n(36,0,16)]}];
  const scaffold=structuredClone(source);scaffold.parts=['solo','voice-s','voice-a','voice-t','voice-b'].map(id=>({...template,id,notes:[n(62,0,4),n(67,16,4)]}));
  // Repeated same harmony should still have a regular rearticulation clock.
  const r=createSourceChant(scaffold,source,{accompanimentIds:['upper','bass'],bassPartId:'bass'},[{first:1,last:4}],{rhythm:'phrase-pulse'});
  expect(r.project.parts[0]).toEqual(scaffold.parts[0]);
  for(let v=1;v<5;v++) {
    expect(r.project.parts[v].notes.filter(n=>n.start<16).map(n=>[n.start,n.duration])).toEqual([[0,3.5],[4,3.5],[8,3.5],[12,3.5]]);
    expect(r.project.parts[v].notes.filter(n=>n.start>=16)).toEqual(scaffold.parts[v].notes.filter(n=>n.start>=16));
  }
});

it('keeps changing source bass and all four rhythm clocks together through allocation', () => {
  const source=createBlankProject(); source.measures=4; source.tempo=65;
  const template=source.parts[0];
  const starts=[0,4,6,8,11], ends=[4,6,8,11,16], roots=[0,5,7,9,2];
  const notes=(upper:boolean)=>starts.flatMap((start,i)=>(upper?[60+roots[i],64+roots[i],67+roots[i]]:[36+roots[i]])
    .map(midi=>({id:`${midi}-${start}`,midi,start,duration:ends[i]-start,velocity:.5})));
  source.parts=[{...template,id:'upper',notes:notes(true)},{...template,id:'bass',notes:notes(false)}];
  const scaffold=structuredClone(source);scaffold.parts=['solo','voice-s','voice-a','voice-t','voice-b'].map(id=>({...template,id,notes:[]}));
  const result=createSourceChant(scaffold,source,{accompanimentIds:['upper','bass'],bassPartId:'bass'},[{first:1,last:4}],{rhythm:'phrase-pulse'});
  for(const part of result.project.parts.slice(1)) for(let bar=0;bar<4;bar++)
    expect(part.notes.filter(n=>n.start>=bar*4&&n.start<bar*4+4).map(n=>[n.start-bar*4,n.duration]))
      .toEqual([[0,1],[1,1],[2,1],[3,.5]]);
  for(let i=0;i<starts.length;i++)expect(result.project.parts[4].notes.find(n=>n.start===starts[i])!.midi!%12).toBe(roots[i]);
});
