import abcjs from 'abcjs';
import { beatsPerBar, toAbc, toMusicXml } from '../src/lib/music';
import { prepareEngravingTune, alignEngravingStaffNames, alignEngravingArpeggios, fitEngravingSystems } from '../src/lib/engraving';
import type { ScorePart, ScoreProject } from '../src/lib/types';
import { reviewSections } from './navigation';
import { mappedVersionTime, playbackPosition, playheadX, readScoreSystems } from './playback';
import type { ScoreSystem, TimelineSegment } from './playback';
import { exportRating, positionLink, positionTime, readPosition, reviewChoices, reviewParts } from './ratings';
import type { CommentField, Rating, Readiness, ReviewPart, ReviewPosition } from './ratings';
import './arrangements.css';

interface Version { label: string; dir: string; identity?: string; segments?: TimelineSegment[] }
interface Song { id: string; title: string; feature?: string; issue?: string; versions: Version[] }
interface Manifest { roundId: string; songs: Song[]; related?: { label: string; manifest: string } }
interface AudioPosition { time: number; playing: boolean }
const app = document.querySelector<HTMLDivElement>('#review-app')!;
const pageUrl = new URL(location.href);
const manifestUrl = new URL(pageUrl.searchParams.get('manifest') ?? '/output/cross-song-round1/manifest.json', pageUrl);
let manifest: Manifest;
let reviewer = '';
let songIndex = 0;
let versionIndex = 0;
let part: ReviewPart = 'mix';
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
let audioRequest: AbortController | undefined;
let audioUrl: string | undefined;
let pendingAudio: AudioPosition | undefined;
let assignedSeek: number | undefined;
let animationFrame = 0;
let resizeTimer = 0;
let persistenceError = false;
const ratings = new Map<string, Rating>();
const projects = new Map<string, ScoreProject>();
const views = new Map<string, { versionIndex: number; part: ReviewPart; browseBar: number; barsPerSystem: number; sectionId: string; time: number }>();
const commentFields = { favorite: '最喜欢的地方', problem: '最需要改的地方' } as const;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const song = () => manifest.songs[songIndex];
const choices = (s = song()) => reviewChoices(manifest.roundId, s.id, s.versions, reviewer);
const choice = () => choices()[versionIndex];
const version = () => choice().version;
const key = (s: Song) => `coro-human-review:${manifest.roundId}:${s.id}`;
const linkTo = (position: ReviewPosition) => positionLink(pageUrl, manifestUrl, position);
function reviewerSeed(): string {
  const storageKey = 'coro-human-review:reviewer:v1';
  const random = [...crypto.getRandomValues(new Uint32Array(2))].join('-');
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    localStorage.setItem(storageKey, random);
  } catch { persistenceError = true; }
  return random;
}
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
function renderSong(position?: ReviewPosition) {
  generation++;
  releaseAudio();
  project = undefined;
  systems = [];
  visibleSystem = -1;
  activeSystem = -1;
  scrollPosition = { top: 0, left: 0 };
  playhead = undefined;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  const savedView = views.get(song().id);
  versionIndex = position ? choices().findIndex(c => c.ref === position.versionRef) : savedView?.versionIndex ?? 0;
  part = position?.part ?? savedView?.part ?? 'mix';
  browseBar = position?.bar ?? savedView?.browseBar ?? 1;
  barsPerSystem = savedView?.barsPerSystem ?? 4;
  sectionId = position ? 'all' : savedView?.sectionId ?? 'all';
  if (position) following = true;
  pendingAudio = { time: savedView?.time ?? 0, playing: false };
  element('main').innerHTML = `<div class="song-heading"><div><h2>${esc(song().title)}</h2><div id="song-context"></div></div></div><p id="position-error" class="audio-error" role="status"></p>
  <div class="workspace"><section class="listening" aria-label="试听与读谱">
    <div class="listening-top"><div id="versions" class="row versions" aria-label="试听版本"></div>
      <div class="row"><label for="part">声部</label><select id="part" class="part-switch">${Object.entries(reviewParts).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select><small>切换保留播放位置</small></div>
      <audio id="audio" controls preload="metadata" aria-label="编曲试听音频"></audio><p id="audio-error" class="audio-error" role="status"></p>
    </div>
    <div class="row score-toolbar"><label>段落 <select id="section" disabled><option value="all" data-start="1">全曲</option></select></label><label>每行最多 <select id="bars"><option value="2">2 小节</option><option value="4" selected>4 小节</option></select></label><button id="follow" type="button" aria-pressed="${following}">跟随播放</button></div>
    <div id="score-scroll" class="score-scroll" role="region" aria-label="五线谱" tabindex="0"><div id="score"><p role="status">正在读取乐谱…</p></div></div>
    <div class="score-footer"><div class="row"><button id="previous" aria-label="上一行乐谱">↑</button><span id="range"></span><button id="next" aria-label="下一行乐谱">↓</button><button id="play-from-bar">从此处试听</button><span id="play-position"></span></div><button id="download" class="download">下载当前版 MusicXML</button></div>
  </section><form class="rating" id="rating"><h2>这版能上排练吗？</h2><fieldset><legend>${song().versions.length > 1 ? '更愿意采用' : '是否愿意采用'}</legend><div class="choices">${choices().map(({ alias }) => `<label class="choice"><input type="radio" name="preference" value="${alias}">${alias}</label>`).join('')}${song().versions.length > 1 ? '<label class="choice"><input type="radio" name="preference" value="equal">无偏好</label>' : ''}<label class="choice"><input type="radio" name="preference" value="neither">${song().versions.length > 1 ? '都不满意' : '不满意'}</label></div></fieldset>
  <div class="rating-fields">${choices().map(({ alias }, i) => `<fieldset class="version-rating"><legend>${alias}</legend><label class="field">可用程度<select name="readiness-${i}" required><option value="">请选择</option><option value="direct">可直接使用</option><option value="light">轻改后可用</option><option value="rewrite">需要重写</option></select></label>${Object.entries(commentFields).map(([field, title]) => `<label class="field">${title}<textarea name="${field}-${i}"></textarea></label><div class="row comment-anchor"><a id="anchor-link-${field}-${i}" hidden></a><button type="button" data-anchor="${field}" data-choice="${i}" disabled>标记当前位置</button><button type="button" id="whole-song-${field}-${i}" data-whole-song="${field}" data-choice="${i}" hidden>整曲</button></div>`).join('')}<label class="field">预计修改时间（分钟）<input type="number" name="minutes-${i}" min="0" step="1" required placeholder="0"></label></fieldset>`).join('')}</div>
  <button type="submit" class="primary">保存盲评</button><span id="save-status" role="status" aria-live="polite"></span><div id="reveal" class="reveal"></div></form></div>`;
  const form = element<HTMLFormElement>('rating');
  const current = rating();
  const preference = choices().find(c => c.version.label === current.preference)?.alias ?? current.preference;
  form.querySelectorAll<HTMLInputElement>('[name="preference"]').forEach(input => { input.checked = input.value === preference; });
  choices().forEach(({ version: candidate }, i) => {
    const saved = current.versions[candidate.label];
    for (const [field, value] of Object.entries({ readiness: saved.readiness, favorite: saved.favorite, problem: saved.problem, minutes: saved.estimatedEditMinutes ?? '' })) {
      (form.elements.namedItem(`${field}-${i}`) as HTMLInputElement).value = String(value);
    }
  });
  form.addEventListener('input', event => {
    const target = event.target;
    collectRating(target instanceof HTMLTextAreaElement ? target.name : undefined);
  });
  form.querySelectorAll<HTMLButtonElement>('[data-anchor], [data-whole-song]').forEach(button => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.choice);
      const position = button.dataset.wholeSong ? null : currentPosition(index);
      if (position === undefined) return;
      const field = (button.dataset.anchor ?? button.dataset.wholeSong) as CommentField;
      const candidate = choices()[index].version;
      (rating().versions[candidate.label].anchors ??= {})[field] = position;
      persist();
      renderCommentAnchors();
      (form.elements.namedItem(`${field}-${index}`) as HTMLTextAreaElement).focus();
    });
  });
  form.querySelectorAll<HTMLAnchorElement>('.comment-anchor a').forEach(link => link.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(null, '', link.href);
    if (openPosition(readPosition(location.hash))) {
      element('score-scroll').focus({ preventScroll: true });
      element('score-scroll').scrollIntoView({ block: 'nearest' });
    }
  }));
  form.addEventListener('submit', submitRating);
  element<HTMLSelectElement>('part').value = part;
  element<HTMLSelectElement>('bars').value = String(barsPerSystem);
  element('part').addEventListener('change', () => {
    part = element<HTMLSelectElement>('part').value as ReviewPart;
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
  renderCommentAnchors();
  renderReveal();
  element('save-status').textContent = persistenceError ? '浏览器无法保存，请及时导出评分。' : current.updatedAt ? '已恢复此浏览器中的评分。' : '';
  void loadVersion(pendingAudio, undefined, position);
}
function renderVersions() {
  element('versions').innerHTML = choices().map(({ alias }, i) => `<button type="button" data-version="${i}" aria-pressed="${i === versionIndex}">${alias}</button>`).join('');
  element('versions').querySelectorAll<HTMLButtonElement>('button').forEach(button => button.addEventListener('click', () => selectVersion(Number(button.dataset.version))));
}
function selectVersion(index: number) {
  if (versionIndex === index) return;
  const previous = project ? { project, version: version() } : undefined;
  const position = audioPosition();
  versionIndex = index;
  renderVersions();
  void loadVersion(position, previous);
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
function releaseAudio() {
  audioGeneration++;
  audioRequest?.abort();
  audioRequest = undefined;
  const audio = document.getElementById('audio') as HTMLAudioElement | null;
  if (audio) {
    audio.onloadedmetadata = null;
    audio.onerror = null;
    if (audio.hasAttribute('src')) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = undefined;
}
async function switchAudio(position: AudioPosition) {
  const audio = element<HTMLAudioElement>('audio');
  pendingAudio = position;
  assignedSeek = undefined;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  releaseAudio();
  const audioToken = audioGeneration;
  const controller = new AbortController();
  audioRequest = controller;
  element('audio-error').textContent = '';
  const isCurrent = () => audioToken === audioGeneration && audio.isConnected;
  const failed = () => {
    if (isCurrent()) element('audio-error').textContent = '此音频尚未生成或无法播放，可切换其他声部。';
  };
  try {
    const response = await fetch(asset(`${part}.m4a`), { signal: controller.signal });
    if (!response.ok) throw new Error('Audio unavailable');
    const blob = await response.blob();
    if (!isCurrent()) return;
    audioUrl = URL.createObjectURL(blob);
    audio.src = audioUrl;
  } catch { failed(); return; }
  element('audio-error').textContent = '';
  audio.onloadedmetadata = () => {
    if (!isCurrent()) return;
    const next = pendingAudio ?? position;
    pendingAudio = undefined;
    seekAudio(audio, next.time);
    updateCursor();
    if (next.playing) playAudio(audio, audioToken);
  };
  audio.onerror = failed;
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
async function loadVersion(position: AudioPosition, previous?: { project: ScoreProject; version: Version }, anchor?: ReviewPosition) {
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
  renderCommentAnchors();
  try {
    const selectedVersion = versionIndex;
    const candidates = choices().map(c => c.version);
    const cached = candidates.map(candidate => projects.get(asset('arrangement.json', candidate)));
    const loaded = cached.every(item => item !== undefined) ? cached : await Promise.all(candidates.map(readProject));
    if (token !== generation) return;
    project = loaded[selectedVersion];
    if (anchor) {
      const time = positionTime(anchor, project);
      if (time === undefined) element('position-error').textContent = '此定位超出当前乐谱的范围。';
      position = { time: time ?? 0, playing: false };
    } else if (previous) {
      const remap = (time: number) => mappedVersionTime(time, previous.project, project!, previous.version.segments, version().segments);
      position = { ...position, time: remap(position.time) };
      if (!following) {
        const browseTime = (browseBar - 1) * beatsPerBar(previous.project) * 60 / previous.project.tempo;
        browseBar = playbackPosition(remap(browseTime), project).bar;
      }
    }
    browseBar = Math.min(browseBar, project.measures);
    renderSections(loaded);
    element<HTMLButtonElement>('download').disabled = false;
    void switchAudio(position);
    renderScore();
    renderCommentAnchors();
  } catch {
    if (token === generation) element('score').textContent = '乐谱无法读取，请切换版本或重新载入。';
  }
}
function renderSections(scores: readonly ScoreProject[]) {
  const sections = reviewSections(scores, project, !rating().revealedAt);
  const section = element<HTMLSelectElement>('section');
  section.innerHTML = sections.map(s => `<option value="${s.id}" data-start="${s.start}" data-end="${s.end}">${esc(s.label)}</option>`).join('');
  if ([...section.options].some(o => o.value === sectionId)) section.value = sectionId;
  sectionId = section.value;
  section.disabled = false;
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
    const voice = part;
    const selected = voice === 'mix' ? undefined : project.parts.filter(p => partMatches(p, voice)).map(p => p.id);
    if (selected?.length === 0) throw new Error('此乐谱没有对应声部，请切换合唱混音查看全谱。');
    const anonymous = anonymousNotation(project);
    const result = toAbc(anonymous, selected, { barsPerSystem, staffSep: 37, systemSep: 32 });
    const [tune] = abcjs.renderAbc(holder, result.abc, {
      responsive: 'resize', oneSvgPerLine: true, add_classes: true, selectTypes: false,
      staffwidth: Math.max(590, Math.min(1080, area.clientWidth - 58)),
      paddingtop: 0, paddingbottom: 12, paddingleft: 10, paddingright: 14,
      afterParsing: tune => prepareEngravingTune(tune, result),
      ariaLabel: `${song().title}，${choice().alias}`,
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
  } catch (error) {
    holder.textContent = error instanceof Error && error.message.startsWith('此乐谱没有对应声部')
      ? error.message : '暂时无法显示乐谱，可下载 MusicXML。';
  }
  scrollPosition = { top: area.scrollTop, left: area.scrollLeft };
  if (!systems.length) updateNavigation(-1, browseBar);
  updateCursor(true);
}
function partMatches(scorePart: ScorePart, voice: Exclude<ReviewPart, 'mix'>): boolean {
  const label = `${scorePart.id} ${scorePart.shortName} ${scorePart.name}`.toLowerCase();
  if (voice === 'solo') return scorePart.role === 'lead' || /\bsolo\b/.test(label);
  return new RegExp(`(^|[^a-z])${voice}([^a-z]|$)`).test(label) || { s: /soprano|女高/, a: /alto|女低/, t: /tenor|男高/, b: /bass|男低/ }[voice].test(label);
}
function anonymousNotation(score: ScoreProject): ScoreProject {
  const voices = ['solo', 's', 'a', 't', 'b'] as const;
  return {
    ...score,
    title: '',
    composer: '',
    parts: score.parts.map((p, index) => {
      const voice = voices.find(id => partMatches(p, id));
      const shortName = voice === 'solo' ? 'Solo' : voice?.toUpperCase() ?? `声部 ${index + 1}`;
      return { ...p, name: shortName, shortName, instrument: voice ? 'Voice' : 'Instrument' };
    }),
  };
}
function currentPosition(index: number): ReviewPosition | undefined {
  if (!project) return;
  const audio = audioPosition();
  const playback = playbackPosition(audio.time, project);
  const atPlayback = playback.bar === browseBar || (following && audio.playing);
  const current = { songId: song().id, versionRef: choice().ref, part, bar: atPlayback ? playback.bar : browseBar, beat: atPlayback ? playback.pulse : 1 };
  if (index === versionIndex) return current;
  const target = choices()[index];
  const score = projects.get(asset('arrangement.json', target.version));
  const time = positionTime(current, project);
  if (!score || time === undefined) return;
  const mapped = playbackPosition(mappedVersionTime(time, project, score, version().segments, target.version.segments), score);
  return { ...current, versionRef: target.ref, bar: mapped.bar, beat: mapped.pulse };
}
function renderCommentAnchors() {
  const current = rating();
  const form = element<HTMLFormElement>('rating');
  const variants = choices();
  form.querySelectorAll<HTMLButtonElement>('[data-anchor]').forEach(button => {
    const i = Number(button.dataset.choice);
    const field = button.dataset.anchor as CommentField;
    const { version: candidate, alias } = variants[i];
    const saved = current.versions[candidate.label].anchors?.[field];
    const link = element<HTMLAnchorElement>(`anchor-link-${field}-${i}`);
    link.hidden = !saved;
    if (saved) {
      link.href = linkTo(saved);
      link.textContent = `${reviewParts[saved.part]} · ${saved.bar} 小节 ${saved.beat} 拍`;
      link.setAttribute('aria-label', `${alias} ${commentFields[field]}，${link.textContent}`);
    } else link.removeAttribute('href');
    const wholeSong = element<HTMLButtonElement>(`whole-song-${field}-${i}`);
    wholeSong.hidden = !saved;
    wholeSong.setAttribute('aria-label', `${alias} ${commentFields[field]}，改为整曲评论`);
    button.textContent = saved ? '更新位置' : '标记当前位置';
    button.setAttribute('aria-label', `${alias} ${commentFields[field]}，${button.textContent}`);
    button.disabled = !project;
  });
}
function collectRating(editedComment?: string) {
  const form = element<HTMLFormElement>('rating');
  const current = rating();
  const selection = form.querySelector<HTMLInputElement>('[name="preference"]:checked')?.value ?? '';
  current.preference = choices().find(c => c.alias === selection)?.version.label ?? selection;
  choices().forEach(({ version: candidate }, i) => {
    const value = (field: string) => (form.elements.namedItem(`${field}-${i}`) as HTMLInputElement).value;
    const saved = current.versions[candidate.label];
    const anchors = { ...saved.anchors };
    for (const field of ['favorite', 'problem'] as const) {
      if (saved[field].trim() && !value(field).trim()) delete anchors[field];
      if (editedComment === `${field}-${i}` && value(field).trim() && !Object.hasOwn(anchors, field)) {
        const position = currentPosition(i);
        if (position) anchors[field] = position;
      }
    }
    current.versions[candidate.label] = { readiness: value('readiness') as Readiness, favorite: value('favorite'), problem: value('problem'), estimatedEditMinutes: value('minutes') === '' ? null : Number(value('minutes')), anchors };
  });
  persist();
  renderCommentAnchors();
}
function submitRating(event: SubmitEvent) {
  event.preventDefault();
  collectRating();
  const current = rating();
  if (!current.preference) { element('save-status').textContent = '请选择采用意向。'; return; }
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
  const revealed = !!(current.blindSubmittedAt && current.revealedAt);
  renderRelated(revealed);
  submit.textContent = current.blindSubmittedAt ? '更新评分' : '保存盲评';
  element('song-context').innerHTML = revealed
    ? `${song().feature ? `<p class="muted">${esc(song().feature)}</p>` : ''}${song().issue ? `<p>${esc(song().issue)}</p>` : ''}` : '';
  if (!current.blindSubmittedAt) { target.textContent = '版本说明在保存盲评后开放。'; return; }
  if (!current.revealedAt) {
    target.innerHTML = '<button id="show-identity" type="button">查看版本说明</button>';
    element('show-identity').addEventListener('click', () => {
      current.revealedAt = new Date().toISOString();
      persist();
      renderReveal();
      if (project && song().versions.length === 1) renderSections([project]);
    });
    return;
  }
  target.innerHTML = choices().map(({ alias, version: candidate }, i) => `<div class="revealed-version"><p class="identity"><strong>${alias}</strong>：${esc(candidate.identity ?? candidate.label)}</p><button type="button" class="project-download" data-project="${i}">下载 ${alias} .coro 工程</button></div>`).join('') + '<p id="project-error" class="audio-error" role="status"></p>';
  target.querySelectorAll<HTMLButtonElement>('[data-project]').forEach(button => button.addEventListener('click', () => downloadProject(choices()[Number(button.dataset.project)], button)));
}
function renderRelated(revealed: boolean) {
  const existing = document.querySelector<HTMLAnchorElement>('.related-round');
  if (!revealed) { existing?.remove(); return; }
  if (existing || !manifest.related?.label || !manifest.related.manifest) return;
  try {
    const relatedUrl = localUrl(manifest.related.manifest);
    const destination = new URL(pageUrl.pathname, pageUrl);
    destination.searchParams.set('manifest', relatedUrl.pathname + relatedUrl.search);
    const link = document.createElement('a');
    link.className = 'related-round';
    link.href = destination.href;
    link.textContent = manifest.related.label;
    element('header-actions').prepend(link);
  } catch { /* Invalid or external optional links do not block this round. */ }
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadScore() {
  if (!project) return;
  const filename = `${song().title}-${choice().alias}.musicxml`;
  try {
    const xml = toMusicXml({ ...anonymousNotation(project), title: song().title });
    download(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), filename);
  } catch { element('audio-error').textContent = '下载失败，请重试。'; }
}
async function downloadProject({ alias, version: candidate }: ReturnType<typeof choices>[number], button: HTMLButtonElement) {
  if (!rating().blindSubmittedAt || !rating().revealedAt) return;
  const filename = `${song().title}-${alias}.coro`;
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
function rememberView() {
  const audio = document.getElementById('audio') as HTMLAudioElement | null;
  if (!audio) return;
  views.set(song().id, { versionIndex, part, browseBar, barsPerSystem, sectionId, time: audioPosition().time });
  audio.pause();
}
function openPosition(position: ReviewPosition | undefined): boolean {
  const index = manifest.songs.findIndex(s => s.id === position?.songId);
  if (!position || index < 0 || !choices(manifest.songs[index]).some(c => c.ref === position.versionRef)) {
    const target = document.getElementById('position-error');
    if (target && location.hash) target.textContent = '此定位不属于当前试听清单。';
    return false;
  }
  rememberView();
  songIndex = index;
  renderSong(position);
  return true;
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
        if (!v.label || ['neither', 'equal'].includes(v.label) || labels.has(v.label) || !v.dir) throw new Error('版本标签必须唯一，且目录不能为空。');
        labels.add(v.label); localUrl(v.dir);
      }
    }
    reviewer = reviewerSeed();
    app.innerHTML = '<header><div class="brand"><strong>Coro</strong><h1>编曲试听</h1></div><div class="row" id="header-actions"><small id="progress"></small><button id="export">导出评分</button></div></header><div class="shell"><nav id="songs" aria-label="试听歌曲"></nav><main id="main"></main></div>';
    element('songs').addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-song]');
      if (!button || Number(button.dataset.song) === songIndex) return;
      rememberView();
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      songIndex = Number(button.dataset.song);
      renderSong();
    });
    element('export').addEventListener('click', () => {
      const results = manifest.songs.map(s => exportRating(rating(s), choices(s), linkTo));
      const roundId = results.every(result => result.identities) ? manifest.roundId : undefined;
      download(new Blob([JSON.stringify({ schemaVersion: 2, roundId, exportedAt: new Date().toISOString(), ratings: results }, null, 2)], { type: 'application/json' }), 'coro-review.json');
    });
    if (!openPosition(readPosition(location.hash))) {
      renderSong();
      if (location.hash) element('position-error').textContent = '此定位不属于当前试听清单。';
    }
    window.addEventListener('hashchange', () => openPosition(readPosition(location.hash)));
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(renderScore, 180); });
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>暂时无法打开试听</h1><p>${esc(error instanceof Error ? error.message : '读取失败。')}</p><p class="muted">请先生成本轮 manifest.json，再重新载入。</p><button id="retry">重新载入</button></div>`;
    element('retry').addEventListener('click', () => location.reload());
  }
}
void start();
