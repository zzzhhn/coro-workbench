import abcjs from 'abcjs';
import {toAbc} from '../src/lib/music';
import {prepareEngravingTune,fitEngravingSystems} from '../src/lib/engraving';
import type {ScoreProject} from '../src/lib/types';
const base='http://127.0.0.1:8787';
const sel=(id:string)=>document.querySelector<HTMLSelectElement>('#'+id)!;
const audio=(id:string)=>document.querySelector<HTMLAudioElement>('#'+id)!;
const section=sel('section'),model=sel('model');
const players=['original','stem','raw','score','medium-raw','medium-score','reference-audio','coro-audio'].map(audio);
const pages=[1,5,9,13,17,21,25,29,33,37,41,44,48,52,56,59,62,66,70];
let begin=0,end=0,timer=0;
function pause(){clearTimeout(timer);players.forEach(p=>p.pause());}
function seek(p:HTMLAudioElement){if(p.readyState>=1)p.currentTime=begin;}
function stopAtEnd(p:HTMLAudioElement){clearTimeout(timer);timer=window.setTimeout(()=>{if(!p.paused){if(p.currentTime>=end)p.pause();else stopAtEnd(p);}},Math.max(30,(end-p.currentTime)*1000));}
for(const p of players){p.addEventListener('loadedmetadata',()=>seek(p));p.addEventListener('play',()=>{players.filter(x=>x!==p).forEach(x=>x.pause());if(p.currentTime<begin||p.currentTime>=end)seek(p);stopAtEnd(p);});p.addEventListener('seeked',()=>{if(!p.paused)stopAtEnd(p);});}
function renderScore(target:string,p:ScoreProject,first:number){
 const q=structuredClone(p),a=first*4,b=a+16;
 q.title='';q.composer='';q.measures=4;q.chords=[];
 q.parts=q.parts.map(part=>({...part,notes:part.notes.filter(n=>n.start<b&&n.start+n.duration>a).map(n=>({...n,start:Math.max(a,n.start)-a,duration:Math.min(b,n.start+n.duration)-Math.max(a,n.start)}))}));
 const result=toAbc(q,undefined,{barsPerSystem:4,staffSep:35,systemSep:35});
 const node=document.querySelector<HTMLDivElement>('#'+target)!;
 abcjs.renderAbc(node,result.abc,{staffwidth:1050,responsive:'resize',oneSvgPerLine:true,afterParsing:t=>prepareEngravingTune(t,result)});
 fitEngravingSystems([...node.querySelectorAll<SVGSVGElement>('svg')]);
}
try{
 const response=await fetch(base+'/review-data.json');if(!response.ok)throw Error('本地对照素材未就绪');
 const data=await response.json();
 for(let first=1;first<=69;first+=4)section.add(new Option(`手谱 ${first}～${Math.min(70,first+3)} 小节`,String(first)));
 for(const [key,value] of Object.entries(data.variants) as [string,{title:string}][])if(!['reference','coro'].includes(key))model.add(new Option(value.title,key));
 model.value=data.variants['game-large-k1']?'game-large-k1':'game-medium';section.value='13';
 function render(){pause();const first=Number(section.value),v=data.variants[model.value];
   begin=data.referenceOffset+(first-1)*data.secondsPerBar;end=Math.min(267.102041,begin+4*data.secondsPerBar);
   document.querySelector('#range')!.textContent=`${begin.toFixed(1)}～${end.toFixed(1)} 秒`;
   const native=data.nativeSlices[String(first)];
   document.querySelector('#model-title')!.textContent=v.title+(model.value==='sheetsage'?` · 原生谱 ${native.firstNativeBar}～${native.lastNativeBar} 小节`:' · 原始音符＋同一 Coro 记谱');
   audio('raw').src=base+`/playback/${model.value}-raw.wav`;audio('score').src=base+`/playback/${model.value}-score.wav`;
   audio('reference-audio').src=base+'/playback/reference-raw.wav';audio('coro-audio').src=base+'/playback/coro-score.wav';
   document.querySelector<HTMLAnchorElement>('#midi')!.href=base+`/playback/${model.value}-raw.mid`;
   audio('score').parentElement!.hidden=model.value==='sheetsage';
   if(model.value==='sheetsage')abcjs.renderAbc('candidate',native.abc,{staffwidth:1050,responsive:'resize'});
   else renderScore('candidate',v.project,first);
   const control=data.variants['game-medium-phrases'];
   document.querySelector<HTMLElement>('#medium-control')!.hidden=!control||model.value==='game-medium-phrases';
   if(control){renderScore('medium-candidate',control.project,first);audio('medium-raw').src=base+'/playback/game-medium-phrases-raw.wav';audio('medium-score').src=base+'/playback/game-medium-phrases-score.wav';}
   renderScore('reference',data.variants.reference.project,first);renderScore('coro',data.variants.coro.project,first);
   const scans=document.querySelector('#reference-pages')!;scans.replaceChildren();
   pages.forEach((start,index)=>{if(start>Math.min(70,first+3)||(pages[index+1]??71)<=first)return;const image=document.createElement('img');image.src=base+'/reference/'+String(index+1).padStart(2,'0')+'.png';image.alt=`用户原版手扒谱，第 ${index+1} 页，从第 ${start} 小节开始`;image.style.width='100%';scans.append(image);});players.forEach(seek);
 }
 section.onchange=render;model.onchange=render;
 document.querySelector<HTMLButtonElement>('#prev')!.onclick=()=>{section.selectedIndex=Math.max(0,section.selectedIndex-1);render();};
 document.querySelector<HTMLButtonElement>('#next')!.onclick=()=>{section.selectedIndex=Math.min(section.options.length-1,section.selectedIndex+1);render();};render();
 document.querySelector<HTMLDetailsElement>('#native')!.ontoggle=async e=>{if(!(e.currentTarget as HTMLDetailsElement).open)return;const r=await fetch(base+'/native.abc');if(r.ok)abcjs.renderAbc('native-score',await r.text(),{staffwidth:1050,responsive:'resize'});else document.querySelector('#native-score')!.textContent='尚无 SheetSage2 原生输出';};
}catch(e){document.querySelector('#status')!.textContent=String(e);}
