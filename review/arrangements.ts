import abcjs from 'abcjs';
import { beatsPerBar, toAbc, toMusicXml } from '../src/lib/music';
import { prepareEngravingTune, alignEngravingStaffNames, alignEngravingArpeggios, fitEngravingSystems } from '../src/lib/engraving';
import type { ScoreProject } from '../src/lib/types';
import { reviewSections } from './navigation';
import { mappedVersionTime, playbackPosition, playheadX, readScoreSystems } from './playback';
import type { ScoreSystem, TimelineSegment } from './playback';
import './arrangements.css';

interface Version { label: string; dir: string; identity?: string; segments?: TimelineSegment[] }
interface Song { id: string; title: string; feature?: string; issue?: string; versions: Version[] }
interface Manifest { roundId: string; songs: Song[]; related?: { label: string; manifest: string } }
type Readiness = '' | 'direct' | 'light' | 'rewrite';
interface AudioPosition { time: number; playing: boolean }
interface VersionRating { readiness: Readiness; favorite: string; problem: string; estimatedEditMinutes: number | null }
interface Rating {
  roundId: string; songId: string; preference: string; versions: Record<string, VersionRating>;
  updatedAt: string; blindSubmittedAt?: string; blindSnapshot?: unknown; revealedAt?: string;
}
const app = document.querySelector<HTMLDivElement>('#review-app')!;
const manifestUrl = new URL(new URLSearchParams(location.search).get('manifest') ?? '/output/cross-song-round1/manifest.json', location.href);
let manifest: Manifest;
let songIndex = 0;
let versionIndex = 0;
let part = 'mix';
let browseBar = 1;
let barsPerSystem = 4;
let sectionId = 'all';
let following = true;
let systems: ScoreSystem[] = [];
let visibleSystem = -1;
let activeSystem = -1;
let scrollPosition = { top: 0, left: 0 };
let playhead: SVGLineElement | undefined;
let project: ScoreProject | undefined;
let generation = 0;
let audioGeneration = 0;
let pendingAudio: AudioPosition | undefined;
let assignedSeek: number | undefined;
let animationFrame = 0;
let resizeTimer = 0;
let persistenceError = false;
const ratings = new Map<string, Rating>();
const projects = new Map<string, ScoreProject>();
const views = new Map<string, { versionIndex: number; part: string; browseBar: number; barsPerSystem: number; sectionId: string; time: number }>();
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const song = () => manifest.songs[songIndex];
const version = () => song().versions[versionIndex];
const key = (s: Song) => `coro-human-review:${manifest.roundId}:${s.id}`;
function localUrl(path: string, base = manifestUrl): URL {
  const url = new URL(path, base);
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('试听文件必须来自当前本地服务。');
  return url;
}
function asset(filename: string, candidate = version()): string {
  const directory = localUrl(candidate.dir.endsWith('/') ? candidate.dir : `${candidate.dir}/`);
  return localUrl(filename, directory).href;
}
function rating(s = song()): Rating {
  let current = ratings.get(s.id);
  if (!current) {
    try {
      const raw = localStorage.getItem(key(s));
      if (raw) {
        const saved = JSON.parse(raw) as Rating;
        if (saved.roundId === manifest.roundId && saved.songId === s.id && saved.versions) current = saved;
      }
    } catch { persistenceError = true; }
    current ??= { roundId: manifest.roundId, songId: s.id, preference: '', versions: {}, updatedAt: '' };
    for (const v of s.versions) current.versions[v.label] ??= { readiness: '', favorite: '', problem: '', estimatedEditMinutes: null };
    ratings.set(s.id, current);
  }
  return current;
}
function persist() {
  const current = rating();
  current.updatedAt = new Date().toISOString();
  try { localStorage.setItem(key(song()), JSON.stringify(current)); persistenceError = false; }
  catch { persistenceError = true; }
  element('save-status').textContent = persistenceError ? '浏览器无法保存，请及时导出评分。' : current.blindSubmittedAt ? '评分已保存。后续修改保留首次盲评记录。' : '草稿已自动保存在此浏览器。';
}
function renderNavigation() {
  element('songs').innerHTML = manifest.songs.map((s, index) => `<button class="song" data-song="${index}" ${index === songIndex ? 'aria-current="page"' : ''}><span class="number">${String(index + 1).padStart(2, '0')}</span><span class="title">${esc(s.title)}</span>${rating(s).blindSubmittedAt ? '<span class="done" aria-label="已评分">✓</span>' : ''}</button>`).join('');
  const completed = manifest.songs.filter(s => rating(s).blindSubmittedAt).length;
  element('progress').textContent = `${completed} / ${manifest.songs.length} 已评分`;
}
function renderSong() {
  generation++;
  project = undefined;
  systems = [];
  visibleSystem = -1;
  activeSystem = -1;
  scrollPosition = { top: 0, left: 0 };
  playhead = undefined;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  const savedView = views.get(song().id);
  versionIndex = savedView?.versionIndex ?? 0;
  part = savedView?.part ?? 'mix';
  browseBar = savedView?.browseBar ?? 1;
  barsPerSystem = savedView?.barsPerSystem ?? 4;
  sectionId = savedView?.sectionId ?? 'all';
  pendingAudio = { time: savedView?.time ?? 0, playing: false };
  element('main').innerHTML = `<div class="song-heading"><div><h2>${esc(song().title)}</h2><p class="muted">${esc(song().feature ?? '')}</p>${song().issue ? `<p>${esc(song().issue)}</p>` : ''}</div><small>${esc(manifest.roundId)}</small></div>
  <div class="workspace"><section class="listening" aria-label="试听与读谱">
    <div class="listening-top"><div id="versions" class="row versions" aria-label="试听版本"></div>
      <div class="row"><label for="part">声部</label><select id="part" class="part-switch"><option value="mix">合唱混音</option><option value="solo">Solo</option><option value="s">S 女高</option><option value="a">A 女低</option><option value="t">T 男高</option><option value="b">B 男低</option></select><small>切换保留播放位置</small></div>
      <audio id="audio" controls preload="metadata" aria-label="编曲试听音频"></audio><p id="audio-error" class="audio-error" role="status"></p>
    </div>
    <div class="row score-toolbar"><label>段落 <select id="section" disabled><option value="all" data-start="1">全曲</option></select></label><label>每行最多 <select id="bars"><option value="2">2 小节</option><option value="4" selected>4 小节</option></select></label><button id="follow" type="button" aria-pressed="${following}">跟随播放</button></div>
    <div id="score-scroll" class="score-scroll" role="region" aria-label="五线谱" tabindex="0"><div id="score"><p role="status">正在读取乐谱…</p></div></div>
    <div class="score-footer"><div class="row"><button id="previous" aria-label="上一行乐谱">↑</button><span id="range"></span><button id="next" aria-label="下一行乐谱">↓</button><button id="play-from-bar">从此处试听</button><span id="play-position"></span></div><button id="download" class="download">下载当前版 MusicXML</button></div>
  </section><form class="rating" id="rating"><h2>这版能上排练吗？</h2><p class="muted">先听、再评分。保存后可查看版本说明。</p><fieldset><legend>${song().versions.length > 1 ? '更愿意采用' : '是否愿意采用'}</legend><div class="choices">${song().versions.map(v => `<label class="choice"><input type="radio" name="preference" value="${esc(v.label)}">${esc(v.label)}</label>`).join('')}<label class="choice"><input type="radio" name="preference" value="neither">${song().versions.length > 1 ? '两版都不满意' : '不满意'}</label></div></fieldset>
  <div class="rating-fields">${song().versions.map((v, i) => `<fieldset class="version-rating"><legend>${esc(v.label)}</legend><label class="field">可用程度<select name="readiness-${i}" required><option value="">请选择</option><option value="direct">可直接使用</option><option value="light">轻改后可用</option><option value="rewrite">需要重写</option></select></label><label class="field">最喜欢的地方<textarea name="favorite-${i}" placeholder="可写段落或小节号"></textarea></label><label class="field">最需要改的地方<textarea name="problem-${i}" placeholder="例如：第 9–12 小节，低声部太满"></textarea></label><label class="field">预计修改时间（分钟）<input type="number" name="minutes-${i}" min="0" step="1" required placeholder="0"></label></fieldset>`).join('')}</div>
  <button type="submit" class="primary">保存盲评</button><span id="save-status" role="status" aria-live="polite"></span><div id="reveal" class="reveal"></div></form></div>`;
  const form = element<HTMLFormElement>('rating');
  const current = rating();
  form.querySelectorAll<HTMLInputElement>('[name="preference"]').forEach(input => { input.checked = input.value === current.preference; });
  song().versions.forEach((v, i) => {
    const saved = current.versions[v.label];
    for (const [field, value] of Object.entries({ readiness: saved.readiness, favorite: saved.favorite, problem: saved.problem, minutes: saved.estimatedEditMinutes ?? '' })) {
      (form.elements.namedItem(`${field}-${i}`) as HTMLInputElement).value = String(value);
    }
  });
  form.addEventListener('input', collectRating);
  form.addEventListener('change', collectRating);
  form.addEventListener('submit', submitRating);
  element<HTMLSelectElement>('part').value = part;
  element<HTMLSelectElement>('bars').value = String(barsPerSystem);
  element('part').addEventListener('change', () => {
    part = element<HTMLSelectElement>('part').value;
    if (!project) return;
    switchAudio(audioPosition());
    renderScore();
  });
  element('bars').addEventListener('change', () => { barsPerSystem = Number(element<HTMLSelectElement>('bars').value); renderScore(); });
  element('section').addEventListener('change', () => {
    const choice = element<HTMLSelectElement>('section').selectedOptions[0];
    sectionId = choice.value;
    browseToBar(Number(choice.dataset.start));
  });
  element('previous').addEventListener('click', () => browseToBar(systems[visibleSystem - 1]?.firstBar));
  element('next').addEventListener('click', () => browseToBar(systems[visibleSystem + 1]?.firstBar));
  element('follow').addEventListener('click', () => {
    setFollowing(!following);
    if (following) updateCursor(true);
  });
  element('score-scroll').addEventListener('scroll', readScrollPosition, { passive: true });
  element('play-from-bar').addEventListener('click', () => {
    if (!project) return;
    const audio = element<HTMLAudioElement>('audio');
    const time = (browseBar - 1) * beatsPerBar(project) * 60 / project.tempo;
    if (pendingAudio) {
      pendingAudio = { time, playing: true };
      updateCursor(true);
      return;
    }
    seekAudio(audio, time);
    updateCursor(true);
    playAudio(audio, audioGeneration);
  });
  element('download').addEventListener('click', downloadScore);
  bindAudio(element<HTMLAudioElement>('audio'));
  renderNavigation();
  renderVersions();
  renderReveal();
  element('save-status').textContent = persistenceError ? '浏览器无法保存，请及时导出评分。' : current.updatedAt ? '已恢复此浏览器中的评分。' : '';
  void loadVersion(pendingAudio);
}
function renderVersions() {
  element('versions').innerHTML = song().versions.map((v, i) => `<button type="button" data-version="${i}" aria-pressed="${i === versionIndex}">${esc(v.label)}</button>`).join('');
  element('versions').querySelectorAll<HTMLButtonElement>('button').forEach(button => button.addEventListener('click', () => {
    if (versionIndex === Number(button.dataset.version)) return;
    const previous = project ? { project, version: version() } : undefined;
    const position = audioPosition();
    versionIndex = Number(button.dataset.version);
    renderVersions();
    void loadVersion(position, previous);
  }));
}
function audioPosition(): AudioPosition {
  const audio = element<HTMLAudioElement>('audio');
  return pendingAudio ?? { time: audio.currentTime, playing: !audio.paused && !audio.ended };
}
function seekAudio(audio: HTMLAudioElement, time: number) {
  const target = Math.min(time, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - .01) : time);
  if (Math.abs(target - audio.currentTime) < .001) return;
  assignedSeek = target;
  audio.currentTime = target;
}
function playAudio(audio: HTMLAudioElement, token: number) {
  void audio.play().catch(() => {
    if (token === audioGeneration && audio.isConnected) element('audio-error').textContent = '点击播放继续试听。';
  });
}
function bindAudio(audio: HTMLAudioElement) {
  const draw = () => { if (audio.isConnected) updateCursor(); };
  const tick = () => {
    animationFrame = 0;
    if (!audio.isConnected || audio.paused || audio.ended || pendingAudio) return;
    updateCursor();
    animationFrame = requestAnimationFrame(tick);
  };
  audio.addEventListener('play', () => {
    if (!audio.isConnected) return;
    updateCursor(true);
    if (!animationFrame) animationFrame = requestAnimationFrame(tick);
  });
  audio.addEventListener('seeking', () => {
    if (!audio.isConnected || pendingAudio) return;
    const external = assignedSeek === undefined || Math.abs(audio.currentTime - assignedSeek) > .06;
    assignedSeek = undefined;
    updateCursor(external);
  });
  for (const event of ['timeupdate', 'seeked', 'pause', 'ended']) audio.addEventListener(event, draw);
}
function switchAudio(position: AudioPosition) {
  const audio = element<HTMLAudioElement>('audio');
  pendingAudio = position;
  assignedSeek = undefined;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  const audioToken = ++audioGeneration;
  audio.pause();
  element('audio-error').textContent = '';
  audio.src = asset(`${part}.m4a`);
  audio.onloadedmetadata = () => {
    if (audioToken !== audioGeneration || !audio.isConnected) return;
    const next = pendingAudio ?? position;
    pendingAudio = undefined;
    seekAudio(audio, next.time);
    updateCursor();
    if (next.playing) playAudio(audio, audioToken);
  };
  audio.onerror = () => { if (audioToken === audioGeneration && audio.isConnected) element('audio-error').textContent = '此音频尚未生成或无法播放，可切换其他声部。'; };
  audio.load();
}
async function readProject(candidate: Version) {
  const url = asset('arrangement.json', candidate);
  const cached = projects.get(url);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`乐谱读取失败（${response.status}）。`);
  const data = await response.json();
  const loaded = (data.project ?? data) as ScoreProject;
  if (!Array.isArray(loaded.parts) || !Number.isInteger(loaded.measures) || loaded.measures < 1) throw new Error('arrangement.json 不是有效的乐谱项目。');
  projects.set(url, loaded);
  return loaded;
}
async function loadVersion(position: AudioPosition, previous?: { project: ScoreProject; version: Version }) {
  const token = ++generation;
  project = undefined;
  systems = [];
  visibleSystem = -1;
  activeSystem = -1;
  element('score').innerHTML = '<p role="status">正在读取乐谱…</p>';
  element<HTMLButtonElement>('previous').disabled = true;
  element<HTMLButtonElement>('next').disabled = true;
  element<HTMLButtonElement>('play-from-bar').disabled = true;
  element<HTMLButtonElement>('download').disabled = true;
  element<HTMLSelectElement>('section').disabled = true;
  element('range').textContent = '';
  element('play-position').textContent = '';
  try {
    const selectedVersion = versionIndex;
    const candidates = song().versions;
    const cached = candidates.map(candidate => projects.get(asset('arrangement.json', candidate)));
    const loaded = cached.every(item => item !== undefined) ? cached : await Promise.all(candidates.map(readProject));
    if (token !== generation) return;
    project = loaded[selectedVersion];
    if (previous) {
      const remap = (time: number) => mappedVersionTime(time, previous.project, project!, previous.version.segments, version().segments);
      position = { ...position, time: remap(position.time) };
      if (!following) {
        const browseTime = (browseBar - 1) * beatsPerBar(previous.project) * 60 / previous.project.tempo;
        browseBar = playbackPosition(remap(browseTime), project).bar;
      }
    }
    browseBar = Math.min(browseBar, project.measures);
    const sections = reviewSections(loaded, project);
    element('section').innerHTML = sections.map(s => `<option value="${s.id}" data-start="${s.start}" data-end="${s.end}">${esc(s.label)}</option>`).join('');
    const section = element<HTMLSelectElement>('section');
    if ([...section.options].some(o => o.value === sectionId)) section.value = sectionId;
    sectionId = section.value;
    section.disabled = false;
    element<HTMLButtonElement>('download').disabled = false;
    switchAudio(position);
    renderScore();
  } catch (error) {
    if (token === generation) element('score').textContent = error instanceof Error ? error.message : '乐谱无法读取。';
  }
}
function setFollowing(value: boolean) {
  following = value;
  element('follow').setAttribute('aria-pressed', String(value));
}
function systemForBar(bar: number) {
  return systems.findIndex(system => bar <= system.lastBar);
}
function updateNavigation(index: number, bar = systems[index]?.firstBar ?? 1) {
  visibleSystem = index;
  browseBar = bar;
  const system = systems[index];
  element('range').textContent = system
    ? `${system.firstBar === system.lastBar ? system.firstBar : `${system.firstBar}–${system.lastBar}`} / ${project?.measures} 小节`
    : '';
  element<HTMLButtonElement>('previous').disabled = index <= 0;
  element<HTMLButtonElement>('next').disabled = index < 0 || index === systems.length - 1;
  element<HTMLButtonElement>('play-from-bar').disabled = !system;
  const section = element<HTMLSelectElement>('section');
  const selected = section.selectedOptions[0];
  if (selected && (bar < Number(selected.dataset.start) || bar > Number(selected.dataset.end))) {
    sectionId = 'all';
    section.value = sectionId;
  }
}
function scrollScore(top: number, left: number) {
  const area = element('score-scroll');
  area.scrollTo({ top, left, behavior: 'instant' });
  scrollPosition = { top: area.scrollTop, left: area.scrollLeft };
}
function revealSystem(index: number, bar = systems[index].firstBar, alignTop = false) {
  const area = element('score-scroll');
  const svg = systems[index].svg.getBoundingClientRect();
  const viewport = area.getBoundingClientRect();
  if (alignTop || svg.top < viewport.top || svg.bottom > viewport.top + area.clientHeight) {
    scrollScore(area.scrollTop + svg.top - viewport.top - 10, area.scrollLeft);
  }
  updateNavigation(index, bar);
}
function browseToBar(bar: number | undefined) {
  if (bar === undefined) return;
  const index = systemForBar(bar);
  if (index < 0) return;
  if (following && project) {
    const time = (bar - 1) * beatsPerBar(project) * 60 / project.tempo;
    if (pendingAudio) pendingAudio = { ...pendingAudio, time };
    else seekAudio(element<HTMLAudioElement>('audio'), time);
  }
  revealSystem(index, bar, true);
}
function readScrollPosition() {
  const area = element('score-scroll');
  const top = area.scrollTop;
  const left = area.scrollLeft;
  if (!systems.length || (top === scrollPosition.top && left === scrollPosition.left)) return;
  if (following && !element<HTMLAudioElement>('audio').paused) {
    scrollPosition = { top, left };
    updateCursor(true);
    return;
  }
  if (top !== scrollPosition.top) {
    const visibleTop = area.getBoundingClientRect().top + 12;
    const next = systems.findIndex(system => system.svg.getBoundingClientRect().top > visibleTop);
    updateNavigation(next < 0 ? systems.length - 1 : Math.max(0, next - 1));
  }
  scrollPosition = { top, left };
}
function updateCursor(reveal = false) {
  if (!project) return;
  const { beat, bar, pulse } = playbackPosition(audioPosition().time, project);
  const status = element('play-position');
  const label = `第 ${bar} 小节 · 第 ${pulse} 拍`;
  if (status.textContent !== label) status.textContent = label;
  const index = systemForBar(bar);
  if (index < 0 || !playhead) return;
  const system = systems[index];
  const x = playheadX(system.anchors[bar - system.firstBar], beat);
  const changedSystem = activeSystem !== index;
  if (changedSystem) {
    systems[activeSystem]?.svg.removeAttribute('data-playing-system');
    system.svg.dataset.playingSystem = 'true';
    playhead.setAttribute('y1', String(system.top));
    playhead.setAttribute('y2', String(system.bottom));
    system.svg.append(playhead);
    activeSystem = index;
  }
  if (playhead.getAttribute('x1') !== String(x)) {
    playhead.setAttribute('x1', String(x));
    playhead.setAttribute('x2', String(x));
  }
  if (!following) return;
  if (changedSystem || reveal) revealSystem(index, bar, reveal);
  browseBar = bar;
  const area = element('score-scroll');
  if (area.scrollWidth > area.clientWidth) {
    const bounds = system.svg.getBoundingClientRect();
    const view = system.svg.viewBox.baseVal;
    const offset = bounds.left - area.getBoundingClientRect().left + (x - view.x) * bounds.width / view.width;
    if (offset < 12 || offset > area.clientWidth - 12) {
      scrollScore(area.scrollTop, area.scrollLeft + offset - Math.min(100, area.clientWidth / 4));
    }
  }
}

function renderScore() {
  if (!project) return;
  const holder = element('score');
  const area = element('score-scroll');
  systems = [];
  activeSystem = -1;
  visibleSystem = -1;
  holder.style.minWidth = '';
  playhead = undefined;
  try {
    const selected = part === 'mix' ? undefined : project.parts.filter(p => {
      const label = `${p.id} ${p.shortName} ${p.name}`.toLowerCase();
      return part === 'solo' ? p.role === 'lead' || /\bsolo\b/.test(label) : new RegExp(`(^|[^a-z])${part}([^a-z]|$)`).test(label) || ({ s: /soprano|女高/, a: /alto|女低/, t: /tenor|男高/, b: /bass|男低/ }[part]?.test(label) ?? false);
    }).map(p => p.id);
    if (selected?.length === 0) throw new Error('此乐谱没有对应声部，请切换合唱混音查看全谱。');
    const anonymous = anonymousNotation(project);
    const result = toAbc(anonymous, selected, { barsPerSystem, staffSep: 37, systemSep: 32 });
    const [tune] = abcjs.renderAbc(holder, result.abc, {
      responsive: 'resize', oneSvgPerLine: true, add_classes: true, selectTypes: false,
      staffwidth: Math.max(590, Math.min(1080, area.clientWidth - 58)),
      paddingtop: 0, paddingbottom: 12, paddingleft: 10, paddingright: 14,
      afterParsing: tune => prepareEngravingTune(tune, result),
      ariaLabel: `${song().title}，${version().label}`,
    });
    const svgs = [...holder.querySelectorAll<SVGSVGElement>('svg')];
    alignEngravingStaffNames(svgs);
    alignEngravingArpeggios(svgs);
    const boxes = fitEngravingSystems(svgs);
    holder.style.minWidth = `${Math.ceil(Math.max(610, ...boxes.map(box => box.width)))}px`;
    systems = readScoreSystems(svgs, tune, result, project);
    for (const { svg, firstBar, lastBar } of systems) {
      svg.dataset.firstBar = String(firstBar);
      svg.dataset.lastBar = String(lastBar);
      const label = firstBar === lastBar ? `第 ${firstBar} 小节` : `第 ${firstBar} 至 ${lastBar} 小节`;
      svg.setAttribute('aria-label', label);
      const title = svg.querySelector('title');
      if (title) title.textContent = label;
    }
    playhead = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    playhead.classList.add('review-playhead');
    playhead.setAttribute('aria-hidden', 'true');
    if (!following && systems.length) revealSystem(systemForBar(browseBar), browseBar, true);
  } catch (error) { holder.textContent = error instanceof Error ? error.message : '暂时无法显示乐谱，可下载 MusicXML。'; }
  scrollPosition = { top: area.scrollTop, left: area.scrollLeft };
  if (!systems.length) updateNavigation(-1, browseBar);
  updateCursor(true);
}
function anonymousNotation(score: ScoreProject): ScoreProject {
  return {
    ...score,
    title: '',
    composer: '',
    parts: score.parts.map(p => ({ ...p, name: p.shortName || p.name.split(' · ')[0] })),
  };
}
function collectRating() {
  const form = element<HTMLFormElement>('rating');
  const current = rating();
  current.preference = form.querySelector<HTMLInputElement>('[name="preference"]:checked')?.value ?? '';
  song().versions.forEach((v, i) => {
    const value = (field: string) => (form.elements.namedItem(`${field}-${i}`) as HTMLInputElement).value;
    current.versions[v.label] = { readiness: value('readiness') as Readiness, favorite: value('favorite'), problem: value('problem'), estimatedEditMinutes: value('minutes') === '' ? null : Number(value('minutes')) };
  });
  persist();
}
function submitRating(event: SubmitEvent) {
  event.preventDefault();
  collectRating();
  const current = rating();
  if (!current.preference) { element('save-status').textContent = '请选择愿意采用的版本，或选择不满意。'; return; }
  if (!current.blindSubmittedAt) {
    current.blindSubmittedAt = new Date().toISOString();
    current.blindSnapshot = JSON.parse(JSON.stringify({ preference: current.preference, versions: current.versions, submittedAt: current.blindSubmittedAt }));
  }
  persist();
  renderNavigation();
  renderReveal();
}
function renderReveal() {
  const target = element('reveal');
  const current = rating();
  const submit = element<HTMLFormElement>('rating').querySelector<HTMLButtonElement>('[type="submit"]')!;
  submit.textContent = current.blindSubmittedAt ? '更新评分' : '保存盲评';
  if (!current.blindSubmittedAt) { target.textContent = '版本说明在保存盲评后开放。'; return; }
  if (!current.revealedAt) {
    target.innerHTML = '<button id="show-identity" type="button">查看版本说明</button>';
    element('show-identity').addEventListener('click', () => { current.revealedAt = new Date().toISOString(); persist(); renderReveal(); });
    return;
  }
  target.innerHTML = song().versions.map((v, i) => `<div class="revealed-version"><p class="identity"><strong>${esc(v.label)}</strong>：${esc(v.identity ?? v.dir)}</p><button type="button" class="project-download" data-project="${i}">下载 ${esc(v.label)} .coro 工程</button></div>`).join('') + '<p id="project-error" class="audio-error" role="status"></p>';
  target.querySelectorAll<HTMLButtonElement>('[data-project]').forEach(button => button.addEventListener('click', () => downloadProject(song().versions[Number(button.dataset.project)], button)));
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadScore() {
  if (!project) return;
  const filename = `${song().id}-${version().label}.musicxml`;
  try {
    const xml = toMusicXml({ ...anonymousNotation(project), title: song().title });
    download(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), filename);
  } catch (error) { element('audio-error').textContent = error instanceof Error ? error.message : '下载失败，请重试。'; }
}
async function downloadProject(candidate: Version, button: HTMLButtonElement) {
  if (!rating().blindSubmittedAt || !rating().revealedAt) return;
  const filename = `${song().id}-${candidate.label}.coro`;
  const errorTarget = element('project-error');
  errorTarget.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch(asset('score.coro', candidate));
    if (!response.ok) throw new Error('此版本尚未提供 .coro 工程。');
    download(await response.blob(), filename);
  } catch (error) { errorTarget.textContent = error instanceof Error ? error.message : '工程下载失败，请重试。'; }
  finally { button.disabled = false; }
}
async function start() {
  try {
    localUrl(manifestUrl.href);
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`试听清单尚未就绪（${response.status}）。`);
    manifest = await response.json();
    if (!manifest.roundId || !Array.isArray(manifest.songs) || !manifest.songs.length) throw new Error('试听清单为空或格式无效。');
    const ids = new Set<string>();
    for (const s of manifest.songs) {
      if (!s.id || ids.has(s.id) || !s.title || !s.versions?.length) throw new Error('歌曲需要唯一 ID、标题和至少一个版本。');
      ids.add(s.id);
      const labels = new Set<string>();
      for (const v of s.versions) {
        if (!v.label || v.label === 'neither' || labels.has(v.label) || !v.dir) throw new Error('版本标签必须唯一，且目录不能为空。');
        labels.add(v.label); localUrl(v.dir);
      }
    }
    app.innerHTML = '<header><div class="brand"><strong>Coro</strong><h1>编曲试听</h1></div><div class="row" id="header-actions"><small id="progress"></small><button id="export">导出评分</button></div></header><div class="shell"><nav id="songs" aria-label="试听歌曲"></nav><main id="main"></main></div>';
    if (manifest.related?.label && manifest.related.manifest) {
      try {
        const relatedUrl = localUrl(manifest.related.manifest);
        const destination = new URL(location.href);
        destination.searchParams.set('manifest', relatedUrl.href);
        destination.hash = '';
        const link = document.createElement('a');
        link.className = 'related-round';
        link.href = destination.href;
        link.textContent = manifest.related.label;
        element('header-actions').prepend(link);
      } catch { /* Invalid or external optional links do not block this round. */ }
    }
    element('songs').addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-song]');
      if (!button || Number(button.dataset.song) === songIndex) return;
      const audio = element<HTMLAudioElement>('audio');
      views.set(song().id, { versionIndex, part, browseBar, barsPerSystem, sectionId, time: audioPosition().time });
      audio.pause();
      songIndex = Number(button.dataset.song);
      renderSong();
    });
    element('export').addEventListener('click', () => {
      download(new Blob([JSON.stringify({ schemaVersion: 1, roundId: manifest.roundId, exportedAt: new Date().toISOString(), ratings: manifest.songs.map(s => rating(s)) }, null, 2)], { type: 'application/json' }), `${manifest.roundId}-human-review.json`);
    });
    renderSong();
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(renderScore, 180); });
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>暂时无法打开试听</h1><p>${esc(error instanceof Error ? error.message : '读取失败。')}</p><p class="muted">请先生成本轮 manifest.json，再重新载入。</p><button id="retry">重新载入</button></div>`;
    element('retry').addEventListener('click', () => location.reload());
  }
}
void start();
