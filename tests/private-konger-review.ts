import abcjs from 'abcjs';
import { toAbc } from '../src/lib/music';
import { renderProjectAudio } from '../src/lib/audio';
import { prepareEngravingTune, fitEngravingSystems } from '../src/lib/engraving';
import type { ScoreProject } from '../src/lib/types';

const base = 'http://127.0.0.1:8786';
const select = (id: string) => document.querySelector<HTMLSelectElement>('#' + id)!;
const audio = (id: string) => document.querySelector<HTMLAudioElement>('#' + id)!;
const sections = select('section'), parts = select('part'), pages = select('page');
const focus = select('focus'), stemSource = select('stem-source');
const original = audio('original'), stem = audio('stem');
const scorePlayers = { before: audio('score-before'), after: audio('score-after') };
const players = [original, stem, ...Object.values(scorePlayers)];
const status = document.querySelector<HTMLElement>('#status')!;
const pageStarts = [1,5,9,13,17,21,25,29,33,37,41,44,48,52,56,59,62,66,70];
const urls = new Map<HTMLAudioElement, string>();
let generation = 0, busy = false, sectionStart = 0, begin = 0, end = 0, stopTimer = 0;
let projects: Record<'before' | 'after', ScoreProject>;

for (let i=0;i<18;i++) sections.add(new Option('第 '+(i*4+1)+'～'+(i*4+4)+' 小节',String(i)));
for (let i=1;i<=19;i++) pages.add(new Option('第 '+i+' 页',String(i)));
for (let i=0;i<4;i++) focus.add(new Option('',String(i)));
const secondsPerBar = () => 240 / projects.after.tempo;
const pauseAll = () => { window.clearTimeout(stopTimer); players.forEach(player => player.pause()); };
const bounds = (player: HTMLAudioElement) => [begin,end].map(value =>
  value - (player === original || player === stem ? 0 : sectionStart));
function seek(player: HTMLAudioElement) {
  if (player.readyState >= 1) player.currentTime = Math.max(0,bounds(player)[0]);
}
function updateFocus() {
  pauseAll();
  begin = sectionStart + (focus.value === 'all' ? 0 : Number(focus.value) * secondsPerBar());
  end = Math.min(267.102041, begin + secondsPerBar() * (focus.value === 'all' ? 4 : 1));
  document.querySelector('#range')!.textContent = begin.toFixed(1)+'～'+end.toFixed(1)+' 秒';
  players.forEach(seek);
}
function reference() {
  document.querySelector<HTMLImageElement>('#reference')!.src = base+'/reference/score-'+pages.value.padStart(2,'0')+'.png';
}
function clip(project: ScoreProject): ScoreProject {
  const a = (Number(sections.value) * 4 + 1) * 4, b = a + 16;
  const copied = structuredClone(project);
  copied.title=''; copied.composer=''; copied.measures=4; copied.chords=[];
  copied.parts=copied.parts.filter(p => parts.value === 'all' || (parts.value === 'piano'
    ? (p.program===0 || p.program===2) && p.role!=='percussion'
    : parts.value === 'voice' ? p.role==='lead' || p.role==='harmony' : p.program>=40 && p.program<=50));
  copied.parts=copied.parts.map(p=>({...p,notes:p.notes.filter(n=>n.start<b && n.start+n.duration>a)
    .map(n=>({...n,...(n.start<a?{arpeggio:false,arpeggioOffset:undefined}:{}),start:Math.max(0,n.start-a),duration:Math.min(b,n.start+n.duration)-Math.max(a,n.start)}))}));
  copied.parts=copied.parts.filter(p=>p.notes.length);
  if (!copied.parts.length) copied.parts=[{...project.parts[0],name:'此段休止',notes:[]}];
  delete copied.originalAudio;
  return copied;
}
function sourceChanged() {
  pauseAll(); stem.src=base+'/separated/stem-'+stemSource.value+'.wav';
}
function render() {
  pauseAll(); generation++; status.textContent='';
  const first=Number(sections.value)*4+1;
  // Coro includes a leading virtual bar; selectors use the author's numbering.
  sectionStart=projects.after.originalAudio!.offsetSeconds + first * secondsPerBar();
  for(let i=0;i<4;i++) focus.options[i+1].textContent='试听第 '+(first+i)+' 小节';
  document.querySelector<HTMLElement>('#notice')!.hidden=first!==1 || parts.value!=='piano';
  for (const key of ['before','after'] as const) {
    const player=scorePlayers[key];
    player.removeAttribute('src'); player.load(); player.hidden=true;
    const prior=urls.get(player); if(prior) URL.revokeObjectURL(prior); urls.delete(player);
    document.querySelector<HTMLAnchorElement>('#download-'+key)!.hidden=true;
    const data=toAbc(clip(projects[key]),undefined,{barsPerSystem:2,staffSep:38,systemSep:38});
    const target=document.querySelector<HTMLDivElement>('#'+key)!;
    abcjs.renderAbc(target,data.abc,{staffwidth:1100,oneSvgPerLine:true,
      afterParsing:tune=>prepareEngravingTune(tune,data),responsive:'resize'});
    fitEngravingSystems([...target.querySelectorAll<SVGSVGElement>('svg')]);
  }
  updateFocus(); pages.value=String(pageStarts.filter(n=>n<=first).length); reference();
}
async function playScore(key: 'before' | 'after') {
  if (busy) return;
  pauseAll();
  const player=scorePlayers[key], version=generation;
  if (!urls.has(player)) {
    busy=true;
    const buttons=[...document.querySelectorAll<HTMLButtonElement>('#play-before,#play-after')];
    buttons.forEach(button=>button.disabled=true);
    status.textContent='正在按这四小节的音符生成回放…';
    try {
      const {bytes}=await renderProjectAudio(clip(projects[key]));
      if (version!==generation) return;
      const url=URL.createObjectURL(new Blob([Uint8Array.from(bytes)],{type:'audio/wav'}));
      urls.set(player,url); player.src=url; player.hidden=false;
      const link=document.querySelector<HTMLAnchorElement>('#download-'+key)!;
      link.href=url; link.download='空耳-'+key+'-第'+(Number(sections.value)*4+1)+'小节起.wav'; link.hidden=false;
      status.textContent='';
    } catch(error) {
      if(version===generation) status.textContent=error instanceof Error?error.message:'谱面回放生成失败。';
      return;
    } finally { busy=false; buttons.forEach(button=>button.disabled=false); }
  }
  seek(player);
  try { await player.play(); }
  catch { status.textContent='谱面音频已生成，请点击音频播放器的播放按钮。'; }
}
function scheduleStop(player: HTMLAudioElement) {
  if (player.paused) return;
  window.clearTimeout(stopTimer);
  stopTimer=window.setTimeout(()=>{
    if(player.paused) return;
    if(player.currentTime>=bounds(player)[1]) player.pause();
    else scheduleStop(player);
  },Math.max(25,(bounds(player)[1]-player.currentTime)*1000));
}
for (const player of players) {
  player.addEventListener('loadedmetadata',()=>seek(player));
  player.addEventListener('play',()=>{
    players.filter(other=>other!==player).forEach(other=>other.pause());
    const [a,b]=bounds(player);
    if(player.currentTime<a || player.currentTime>=b) player.currentTime=Math.max(0,a);
    scheduleStop(player);
  });
  player.addEventListener('seeked',()=>scheduleStop(player));
  player.addEventListener('timeupdate',()=>{if(player.currentTime>=bounds(player)[1]) player.pause();});
}
focus.onchange=updateFocus; stemSource.onchange=sourceChanged; pages.onchange=reference;
sections.onchange=render;
parts.onchange=()=>{stemSource.value=parts.value==='voice'?'vocals':parts.value==='piano'?'piano':'other';sourceChanged();render();};
document.querySelector<HTMLButtonElement>('#previous')!.onclick=()=>{sections.value=String(Math.max(0,Number(sections.value)-1));render();};
document.querySelector<HTMLButtonElement>('#next')!.onclick=()=>{sections.value=String(Math.min(17,Number(sections.value)+1));render();};
document.querySelector<HTMLButtonElement>('#play-before')!.onclick=()=>void playScore('before');
document.querySelector<HTMLButtonElement>('#play-after')!.onclick=()=>void playScore('after');
try {
  const manifestResponse = await fetch(base+'/review-source.json');
  if (!manifestResponse.ok) throw new Error('整曲谱本尚未登记到工程库，请先准备本地对照素材。');
  const manifest = await manifestResponse.json();
  if (!/^[a-f0-9]{32}$/.test(manifest.jobId)) throw new Error('整曲对照谱本标识无效。');
  const [before,job]=await Promise.all([base+'/baseline/project.json', '/api/jobs/'+manifest.jobId].map(async url=>{
    const response=await fetch(url);
    if(!response.ok) throw new Error('本地对照素材未就绪，请确认 Coro 和素材服务已启动。');
    return response.json();
  }));
  if (job.status !== 'complete' || !job.project) throw new Error('工程库中的整曲谱本尚未完成。');
  const after: ScoreProject = job.project;
  document.querySelector('#current-score-title')!.textContent = after.title + '（工程库同一谱本）';
  projects={before,after}; sourceChanged(); render();
} catch(error) { status.textContent=error instanceof Error?error.message:'本地对照素材加载失败。'; }
