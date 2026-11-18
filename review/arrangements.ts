import abcjs from 'abcjs';
import { beatsPerBar, toAbc } from '../src/lib/music';
import { prepareEngravingTune, alignEngravingStaffNames, alignEngravingArpeggios, fitEngravingSystems } from '../src/lib/engraving';
import type { ScoreProject } from '../src/lib/types';
import { reviewSections } from './navigation';
import './arrangements.css';

interface Version { label: string; dir: string; identity?: string }
interface Song { id: string; title: string; feature?: string; issue?: string; versions: Version[] }
interface Manifest { roundId: string; songs: Song[]; related?: { label: string; manifest: string } }
type Readiness = '' | 'direct' | 'light' | 'rewrite';
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
let firstBar = 1;
let windowSize = 4;
let sectionEnd = Infinity;
let sectionId = 'all';
let navigationMeasures = 1;
let project: ScoreProject | undefined;
let generation = 0;
let audioGeneration = 0;
let pendingAudio: { time: number; playing: boolean } | undefined;
let resizeTimer = 0;
let persistenceError = false;
const ratings = new Map<string, Rating>();
const projects = new Map<string, ScoreProject>();
const views = new Map<string, { versionIndex: number; part: string; firstBar: number; windowSize: number; sectionId: string; time: number }>();
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
  const savedView = views.get(song().id);
  versionIndex = savedView?.versionIndex ?? 0;
  part = savedView?.part ?? 'mix';
  firstBar = savedView?.firstBar ?? 1;
  windowSize = savedView?.windowSize ?? 4;
  sectionId = savedView?.sectionId ?? 'all';
  navigationMeasures = 1;
  sectionEnd = Infinity;
  element('main').innerHTML = `<div class="song-heading"><div><h2>${esc(song().title)}</h2><p class="muted">${esc(song().feature ?? '')}</p>${song().issue ? `<p>${esc(song().issue)}</p>` : ''}</div><small>${esc(manifest.roundId)}</small></div>
  <div class="workspace"><section class="listening" aria-label="试听与读谱">
    <div class="listening-top"><div id="versions" class="row versions" aria-label="试听版本"></div>
      <div class="row"><label for="part">声部</label><select id="part" class="part-switch"><option value="mix">合唱混音</option><option value="solo">Solo</option><option value="s">S 女高</option><option value="a">A 女低</option><option value="t">T 男高</option><option value="b">B 男低</option></select><small>切换保留播放位置</small></div>
      <audio id="audio" controls preload="metadata" aria-label="编曲试听音频"></audio><p id="audio-error" class="audio-error" role="status"></p>
    </div>
    <div class="row score-toolbar"><label>段落 <select id="section" disabled><option value="all" data-start="1">全曲</option></select></label><label>每页 <select id="bars"><option value="2">2 小节</option><option value="4" selected>4 小节</option><option value="8">8 小节</option></select></label></div>
    <div class="score-scroll"><div id="score" aria-label="五线谱" role="img"><p role="status">正在读取乐谱…</p></div></div>
    <div class="score-footer"><div class="row"><button id="previous" aria-label="前一页乐谱">←</button><span id="range"></span><button id="next" aria-label="后一页乐谱">→</button><button id="play-page">试听本页</button></div><button id="download" class="download">下载当前版 MusicXML</button></div>
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
  element<HTMLSelectElement>('bars').value = String(windowSize);
  element('part').addEventListener('change', () => { part = element<HTMLSelectElement>('part').value; switchAudio(false); renderScore(); });
  element('bars').addEventListener('change', () => { windowSize = Number(element<HTMLSelectElement>('bars').value); renderScore(); });
  element('section').addEventListener('change', () => {
    const choice = element<HTMLSelectElement>('section').selectedOptions[0];
    sectionId = choice.value;
    firstBar = Number(choice.dataset.start);
    sectionEnd = Number(choice.dataset.end ?? project?.measures ?? Infinity);
    renderScore();
  });
  element('previous').addEventListener('click', () => { firstBar = Math.max(Number(element<HTMLSelectElement>('section').selectedOptions[0].dataset.start), firstBar - windowSize); renderScore(); });
  element('next').addEventListener('click', () => { firstBar += windowSize; renderScore(); });
  element('play-page').addEventListener('click', () => {
    if (!project) return;
    const audio = element<HTMLAudioElement>('audio');
    const time = (firstBar - 1) * beatsPerBar(project) * 60 / project.tempo;
    if (pendingAudio) { pendingAudio = { time, playing: true }; return; }
    audio.currentTime = Math.min(time, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - .01) : time);
    void audio.play().catch(() => { element('audio-error').textContent = '音频尚未就绪，请稍后再试。'; });
  });
  element('download').addEventListener('click', downloadScore);
  renderNavigation();
  renderVersions();
  renderReveal();
  element('save-status').textContent = persistenceError ? '浏览器无法保存，请及时导出评分。' : current.updatedAt ? '已恢复此浏览器中的评分。' : '';
  loadVersion(true, savedView?.time ?? 0);
}
function renderVersions() {
  element('versions').innerHTML = song().versions.map((v, i) => `<button type="button" data-version="${i}" aria-pressed="${i === versionIndex}">${esc(v.label)}</button>`).join('');
  element('versions').querySelectorAll<HTMLButtonElement>('button').forEach(button => button.addEventListener('click', () => {
    if (versionIndex === Number(button.dataset.version)) return;
    versionIndex = Number(button.dataset.version);
    renderVersions();
    loadVersion(false);
  }));
}
function switchAudio(reset: boolean, resumedTime = 0) {
  const audio = element<HTMLAudioElement>('audio');
  // The element survives version changes; its native controls and playback state remain familiar.
  const time = reset ? resumedTime : pendingAudio?.time ?? audio.currentTime;
  const playing = !reset && (pendingAudio?.playing ?? !audio.paused);
  pendingAudio = { time, playing };
  const audioToken = ++audioGeneration;
  audio.pause();
  element('audio-error').textContent = '';
  audio.src = asset(`${part}.m4a`);
  audio.onloadedmetadata = () => {
    if (audioToken !== audioGeneration) return;
    const position = pendingAudio?.time ?? time;
    const shouldPlay = pendingAudio?.playing ?? playing;
    audio.currentTime = Math.min(position, Number.isFinite(audio.duration) ? Math.max(0, audio.duration - .01) : position);
    pendingAudio = undefined;
    if (shouldPlay) void audio.play().catch(() => { element('audio-error').textContent = '点击播放继续试听。'; });
  };
  audio.onerror = () => { if (audioToken === audioGeneration) element('audio-error').textContent = '此音频尚未生成或无法播放，可切换其他声部。'; };
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
async function loadVersion(reset: boolean, resumedTime = 0) {
  const token = ++generation;
  project = undefined;
  element('score').innerHTML = '<p role="status">正在读取乐谱…</p>';
  element<HTMLButtonElement>('previous').disabled = true;
  element<HTMLButtonElement>('next').disabled = true;
  element<HTMLSelectElement>('section').disabled = true;
  element('range').textContent = '';
  switchAudio(reset, resumedTime);
  try {
    const selectedVersion = versionIndex;
    const loaded = await Promise.all(song().versions.map(readProject));
    if (token !== generation) return;
    project = loaded[selectedVersion];
    const sections = reviewSections(loaded);
    navigationMeasures = sections[0].end;
    firstBar = Math.min(firstBar, navigationMeasures);
    element('section').innerHTML = sections.map(s => `<option value="${s.id}" data-start="${s.start}" data-end="${s.end}">${esc(s.label)}</option>`).join('');
    const section = element<HTMLSelectElement>('section');
    if ([...section.options].some(o => o.value === sectionId)) section.value = sectionId;
    sectionId = section.value;
    section.disabled = false;
    sectionEnd = Number(section.selectedOptions[0].dataset.end);
    renderScore();
  } catch (error) {
    if (token === generation) element('score').textContent = error instanceof Error ? error.message : '乐谱无法读取。';
  }
}
function renderScore() {
  if (!project) return;
  const holder = element('score');
  const end = Math.min(navigationMeasures, sectionEnd, firstBar + windowSize - 1);
  try {
    if (firstBar > project.measures) throw new Error('此版本在当前范围没有乐谱。');
    const selected = part === 'mix' ? undefined : project.parts.filter(p => {
      const label = `${p.id} ${p.shortName} ${p.name}`.toLowerCase();
      return part === 'solo' ? p.role === 'lead' || /\bsolo\b/.test(label) : new RegExp(`(^|[^a-z])${part}([^a-z]|$)`).test(label) || ({ s: /soprano|女高/, a: /alto|女低/, t: /tenor|男高/, b: /bass|男低/ }[part]?.test(label) ?? false);
    }).map(p => p.id);
    if (selected?.length === 0) throw new Error('此乐谱没有对应声部，请切换合唱混音查看全谱。');
    const anonymous = { ...project, title: '', composer: '', parts: project.parts.map(p => ({ ...p, name: p.shortName || p.name.split(' · ')[0] })) };
    const result = toAbc(anonymous, selected, { barsPerSystem: windowSize > 4 ? 4 : windowSize, staffSep: 37, systemSep: 32, measureRange: { start: firstBar, end: Math.min(end, project.measures) } });
    abcjs.renderAbc(holder, result.abc, {
      responsive: 'resize', oneSvgPerLine: true, add_classes: true,
      staffwidth: Math.max(610, Math.min(1080, holder.parentElement!.clientWidth - 45)),
      paddingtop: 0, paddingbottom: 20, paddingleft: 10, paddingright: 14,
      afterParsing: tune => prepareEngravingTune(tune, result),
      ariaLabel: `${song().title}，${version().label}，第 ${firstBar} 至 ${end} 小节`,
    });
    const systems = [...holder.querySelectorAll<SVGSVGElement>('svg')];
    alignEngravingStaffNames(systems);
    alignEngravingArpeggios(systems);
    fitEngravingSystems(systems);
  } catch (error) { holder.textContent = error instanceof Error ? error.message : '暂时无法显示乐谱，可下载 MusicXML。'; }
  element('range').textContent = `${firstBar}–${end} / ${navigationMeasures} 小节`;
  element<HTMLButtonElement>('previous').disabled = firstBar <= Number(element<HTMLSelectElement>('section').selectedOptions[0].dataset.start);
  element<HTMLButtonElement>('next').disabled = end >= Math.min(sectionEnd, navigationMeasures);
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
async function downloadScore() {
  const button = element<HTMLButtonElement>('download');
  const filename = `${song().id}-${version().label}.musicxml`;
  button.disabled = true;
  try {
    const response = await fetch(asset('score.musicxml'));
    if (!response.ok) throw new Error('MusicXML 尚未生成。');
    download(await response.blob(), filename);
  } catch (error) { element('audio-error').textContent = error instanceof Error ? error.message : '下载失败，请重试。'; }
  finally { button.disabled = false; }
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
      views.set(song().id, { versionIndex, part, firstBar, windowSize, sectionId, time: pendingAudio?.time ?? audio.currentTime });
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
