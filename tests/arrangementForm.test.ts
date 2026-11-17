import { expect,it } from 'vitest';
import { createBlankProject } from '../src/lib/demo';
import { applyFormCuts,proposeInterludeCuts } from '../src/lib/arrangementForm';
function fixture(bar=4){
 const p=createBlankProject();p.timeSignature=[bar,4];p.measures=16;
 const part=p.parts[0];const n=(id:string,start:number,duration:number,midi:number|null=60)=>({id,start,duration,midi,velocity:.5});
 p.parts=[{...part,id:'solo',notes:[n('opening',0,bar),n('tail',3*bar,bar/2),n('pickup',11*bar+bar-.25,.25),n('return',12*bar,bar)]},
 {...part,id:'back',notes:Array.from({length:16},(_,i)=>n(`b${i}`,i*bar,bar,48+(i%2)*7)),pedals:[{start:0,end:16*bar}],pedalSustain:[{start:0,end:16*bar}]}];
 p.chords=[{start:0,duration:16*bar,symbol:'C',pitches:[60,64,67],confidence:1}];return p;
}
it('proposes only internal gaps, retains entry and late pickup, and honors protected spans',()=>{
 const p=fixture(),options={leadPartId:'solo'};const plans=proposeInterludeCuts(p,options);
 expect(plans).toHaveLength(1);const c=plans[0];expect(c.start).toBe(16);expect(c.end).toBe(48);
 expect(c.cut.end-c.cut.start).toBe(16);expect(c.cut.start).toBeGreaterThan(c.start);expect(c.cut.end).toBeLessThan(c.end);
 expect(proposeInterludeCuts(p,{...options,protectedSpans:[{start:16,end:48}]})).toEqual([]);
 const b=applyFormCuts(p,[c.cut],options).project;
 expect(b.measures).toBe(12);
 expect(b.parts[0].notes.map(({start,...n})=>n)).toEqual(p.parts[0].notes.map(({start,...n})=>n));
 expect(b.parts[0].notes.at(-2)!.start).toBe(p.parts[0].notes.at(-2)!.start-16);
});
it('rejects cuts through Solo, protected material, overlap, fractions or invalid bounds',()=>{
 const p=fixture();for(const cuts of [[{start:0,end:4}],[{start:16,end:16}],[{start:16.5,end:20}],[{start:16,end:80}],[{start:16,end:24},{start:20,end:28}]])expect(()=>applyFormCuts(p,cuts,{leadPartId:'solo'})).toThrow();
 expect(()=>applyFormCuts(p,[{start:16,end:20}],{leadPartId:'solo',protectedSpans:[{start:18,end:24}]})).toThrow('protected');
});
it('remaps multiple cuts, clips crossing holds and pedals, clears stale sync, and leaves A intact',()=>{
 const p=fixture();p.parts[1].notes=[{id:'hold',start:12,duration:24,midi:60,velocity:.5}];
 p.originalAudio={name:'x',url:'x',duration:60,offsetSeconds:0};const original=structuredClone(p);
 const r=applyFormCuts(p,[{start:16,end:20},{start:24,end:28}],{leadPartId:'solo'});
 expect(p).toEqual(original);expect(r.project.measures).toBe(14);expect(r.project.originalAudio).toBeUndefined();
 expect(r.project.parts[1].notes.map(n=>[n.start,n.duration])).toEqual([[12,4],[16,4],[20,8]]);
 expect(new Set(r.project.parts[1].notes.map(n=>n.id)).size).toBe(3);
 expect(r.project.parts[1].pedalSustain?.map(n=>[n.start,n.end])).toEqual([[0,16],[16,20],[20,56]]);
 expect(r.project.chords.reduce((sum,n)=>sum+n.duration,0)).toBe(56);
});
it('does not shorten short breaks, intros, outros, or full-bar sustained lead notes',()=>{
 const p=fixture();p.parts[0].notes=[{id:'held',start:12,duration:36,midi:60,velocity:.5}];
 expect(proposeInterludeCuts(p,{leadPartId:'solo'})).toEqual([]);
 expect(applyFormCuts(p,[],{leadPartId:'solo'}).project).toEqual(p);
});
it('works in triple meter without fixed bar numbers',()=>{
 const p=fixture(3);const c=proposeInterludeCuts(p,{leadPartId:'solo'})[0];
 expect(c.cut.end-c.cut.start).toBe(12);expect(applyFormCuts(p,[c.cut],{leadPartId:'solo'}).project.measures).toBe(12);
});
it('preserves exact fractional durations outside cuts',()=>{
 const p=fixture();p.parts[0].notes[0].duration=5/6;
 const b=applyFormCuts(p,[{start:20,end:36}],{leadPartId:'solo'}).project;
 expect(b.parts[0].notes[0]).toEqual(p.parts[0].notes[0]);
});
