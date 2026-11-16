import { beatsPerBar } from './music';
import type { ScoreProject } from './types';

const EPS = 1e-6;
export interface FormCut { start: number; end: number }
export interface FormOptions {
  leadPartId: string;
  /** All positions are in the original score, even after multiple cuts. */
  protectedSpans?: FormCut[];
  minimumSilentBars?: number;
  retainedBars?: number;
}
export interface InterludeProposal {
  start: number; end: number; cut: FormCut;
  seamCost: number; crossingNotes: number;
}
const overlaps = (a: FormCut, b: FormCut) => a.start < b.end - EPS && a.end > b.start + EPS;

/** Proposes a reversible cutdown, not an assertion that a rest is expendable.
 * Only internal lead-free gaps qualify. Intro/outro, pickups and protected
 * phrases survive. Choose one splice with held-note and voice-motion costs;
 * do not infer replacement chords or manufacture an instrumental melody. */
export function proposeInterludeCuts(project: ScoreProject, options: FormOptions): InterludeProposal[] {
  const bar = beatsPerBar(project), minimum = options.minimumSilentBars ?? 6, retained = options.retainedBars ?? 4;
  if (!Number.isInteger(minimum) || !Number.isInteger(retained) || retained < 2 || minimum <= retained) throw Error('Invalid form budget');
  const lead = project.parts.find(p => p.id === options.leadPartId);
  if (!lead) throw Error('Missing lead part');
  const voiced = lead.notes.filter(n => n.midi !== null).sort((a,b) => a.start-b.start);
  const phrases: FormCut[] = [];
  for (const n of voiced) {
    const last = phrases.at(-1);
    if (last && n.start <= last.end + EPS) last.end = Math.max(last.end, n.start+n.duration);
    else phrases.push({start:n.start,end:n.start+n.duration});
  }
  const backing = project.parts.filter(p => p.id !== lead.id);
  const proposals: InterludeProposal[] = [];
  for (let i=1;i<phrases.length;i++) {
    const start = Math.ceil((phrases[i-1].end-EPS)/bar)*bar;
    const fullEnd = Math.floor((phrases[i].start+EPS)/bar)*bar;
    if ((fullEnd-start)/bar < minimum) continue;
    // Keep the return's late pickup bar as part of the transition budget.
    const end = fullEnd + (phrases[i].start-fullEnd >= bar/2 ? bar : 0);
    const remove = Math.floor(((end-start)/bar-retained)/2)*2*bar;
    if (remove <= 0) continue;
    const choices: InterludeProposal[] = [];
    for(let from=start+bar;from+remove<=fullEnd && from+remove<=end-bar;from+=bar) {
      const cut={start:from,end:from+remove};
      if ((options.protectedSpans??[]).some(s=>overlaps(cut,s))) continue;
      let crossingNotes=0,motion=0;
      for(const p of backing) {
        const ns=p.notes.filter(n=>n.midi!==null);
        for(const boundary of [cut.start,cut.end]) crossingNotes+=ns.filter(n=>n.start<boundary-EPS&&n.start+n.duration>boundary+EPS).length;
        const left=ns.filter(n=>n.start<cut.start&&n.start+n.duration>=cut.start-.5).sort((a,b)=>b.start-a.start)[0];
        const right=ns.filter(n=>n.start+n.duration>cut.end&&n.start<=cut.end+.5).sort((a,b)=>a.start-b.start)[0];
        if(left&&right)motion+=Math.abs(left.midi!-right.midi!);
        else motion+=12; // Missing boundary evidence is not a smooth splice.
      }
      const imbalance=Math.abs((cut.start-start)-(end-cut.end))/bar;
      choices.push({start,end,cut,crossingNotes,seamCost:crossingNotes*12+motion+imbalance});
    }
    choices.sort((a,b)=>a.seamCost-b.seamCost||a.cut.start-b.cut.start);
    if(choices[0])proposals.push(choices[0]);
  }
  return proposals;
}

/** Apply selected proposals to every score-time surface. Never time-stretch.
 * Return explicit source segments so review, playback and frozen checks use
 * original bar numbers rather than accidentally comparing different phrases. */
export function applyFormCuts(input: ScoreProject, cuts: FormCut[], options: Pick<FormOptions,'leadPartId'|'protectedSpans'>) {
  const bar=beatsPerBar(input), end=input.measures*bar;
  const sorted=cuts.map(c=>({...c})).sort((a,b)=>a.start-b.start);
  const lead=input.parts.find(p=>p.id===options.leadPartId);
  if(!lead)throw Error('Missing lead part');
  for(let i=0;i<sorted.length;i++) {
    const c=sorted[i];
    if(!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end>end||c.end<=c.start
      ||Math.abs(c.start/bar-Math.round(c.start/bar))>EPS||Math.abs(c.end/bar-Math.round(c.end/bar))>EPS
      ||(i>0&&c.start<sorted[i-1].end))throw Error('Invalid form cut');
    if(lead.notes.some(n=>n.midi!==null&&overlaps(c,{start:n.start,end:n.start+n.duration})))throw Error('Form cut intersects Solo');
    if((options.protectedSpans??[]).some(s=>overlaps(c,s)))throw Error('Form cut intersects protected span');
  }
  const segments:Array<{sourceStart:number;sourceEnd:number;targetStart:number}>=[];
  let sourceStart=0,targetStart=0;
  for(const c of [...sorted,{start:end,end}]) {
    if(c.start>sourceStart){segments.push({sourceStart,sourceEnd:c.start,targetStart});targetStart+=c.start-sourceStart;}
    sourceStart=c.end;
  }
  function remap<T extends {start:number;duration:number}>(events:T[]):T[] {
    return events.flatMap(n=>segments.flatMap((s,index)=>{
      const a=Math.max(n.start,s.sourceStart),b=Math.min(n.start+n.duration,s.sourceEnd);
      if(b-a<=EPS)return [];
      const clipped=a!==n.start||b!==n.start+n.duration;
      const result={...n,start:a-s.sourceStart+s.targetStart,duration:clipped?b-a:n.duration};
      if('id' in result && clipped)result.id=`${result.id}-form-${index}`;
      return [result];
    }));
  }
  const project=structuredClone(input);
  if(!sorted.length)return {project,segments,cuts:sorted};
  project.measures=targetStart/bar;
  project.parts.forEach(p=>{
    p.notes=remap(p.notes);
    for(const field of ['pedals','pedalSustain'] as const)if(p[field])p[field]=remap(p[field]!.map(e=>({start:e.start,duration:e.end-e.start}))).map(e=>({start:e.start,end:e.start+e.duration}));
  });
  project.chords=remap(project.chords);
  // These surfaces assume the uncut timeline. Keep them in the immutable A,
  // not as false sync or stale review/section claims in the new arrangement.
  delete project.originalAudio;delete project.pitchReview;delete project.arrangement;
  delete project.source.analysis;delete project.source.omrReview;
  project.source.warnings=[...project.source.warnings,'曲式压缩候选：原谱小节映射见对照记录；原音频同步已解除，尚待试听验收。'];
  return {project,segments,cuts:sorted};
}
