import abcjs from 'abcjs';
import { fitEngravingSystems, prepareEngravingTune } from '../src/lib/engraving';
import { toAbc } from '../src/lib/music';
import type { ScoreProject } from '../src/lib/types';

const endpoint = 'http://127.0.0.1:8788/lyrics-review.json';
const labels = { raw: '原始 Medium', current: '跟唱谱 V2', lyrics: '跟唱谱 V3' };
type Variant = keyof typeof labels;
type AudioSource = 'original' | 'stem' | 'variant';
type Verdict = Variant | 'unsure' | '';
type BarRange = { firstBar: number; lastBar: number };
type Passage = BarRange & { startSeconds: number; endSeconds: number };
type Manifest = {
  id: string;
  grid: { bpm: number; offsetSeconds: number };
  duration: number;
  variants: Record<Variant, { title: string; project: ScoreProject; audioUrl: string }>;
  windows: Passage[];
  originalUrl: string;
  stemUrl: string;
  referencePages: Array<BarRange & { url: string }>;
  notes: string[];
};
type Draft = { preferred: Verdict; comment: string; updatedAt: string };

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status');
const review = element('review');
const audio = element<HTMLAudioElement>('audio');
const play = element<HTMLButtonElement>('play');
const position = element<HTMLInputElement>('position');
const score = element('score');
const reference = element<HTMLDetailsElement>('reference');
const comment = element<HTMLTextAreaElement>('comment');
const exportButton = element<HTMLButtonElement>('export');
const verdicts = [...document.querySelectorAll<HTMLInputElement>('input[name="preferred"]')];
const variantButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-variant]')];
const sourceButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-source]')];

let data: Manifest;
let passage: Passage;
let variant: Variant = 'current';
let source: AudioSource = 'variant';
let cursor = 0;
let playRequest = 0;
let stopTimer = 0;
let scoreWidth = 0;
const drafts = new Map<number, Draft>();
const unsaved = new Set<number>();

const assetUrl = (url: string) => new URL(url, endpoint).href;
const bars = ({ firstBar, lastBar }: BarRange) => `第 ${firstBar}～${lastBar} 小节`;
const draftKey = ({ firstBar, lastBar }: BarRange) => `coro-lyrics-review:${data.id}:${firstBar}:${lastBar}`;

function showPosition() {
  position.value = String(cursor);
  element('time').textContent = `${cursor.toFixed(1)} / ${passage.endSeconds.toFixed(1)} 秒`;
}

function seek(seconds: number) {
  cursor = Math.min(passage.endSeconds, Math.max(passage.startSeconds, seconds));
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) audio.currentTime = cursor;
  showPosition();
}

function pause() {
  playRequest++;
  window.clearTimeout(stopTimer);
  audio.pause();
}

function pauseAtCursor() {
  if (!audio.paused && !audio.seeking && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    cursor = Math.min(passage.endSeconds, Math.max(passage.startSeconds, audio.currentTime));
  }
  pause();
  showPosition();
}

function updateAudio() {
  const url = assetUrl(source === 'variant' ? data.variants[variant].audioUrl : source === 'original' ? data.originalUrl : data.stemUrl);
  if (audio.src !== url) audio.src = url;
  seek(cursor);
  sourceButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.source === source)));
  status.textContent = '';
}

function trackPlayback() {
  window.clearTimeout(stopTimer);
  if (audio.paused || audio.seeking || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (audio.currentTime >= passage.endSeconds - 0.015) {
    pause();
    seek(passage.endSeconds);
    return;
  }
  cursor = Math.max(passage.startSeconds, audio.currentTime);
  showPosition();
  stopTimer = window.setTimeout(trackPlayback, Math.max(20, (passage.endSeconds - cursor) * 1000));
}

async function togglePlayback() {
  if (!audio.paused) {
    pauseAtCursor();
    return;
  }
  if (cursor >= passage.endSeconds - 0.015) seek(passage.startSeconds);
  const request = ++playRequest;
  status.textContent = '';
  try {
    await audio.play();
  } catch {
    if (request === playRequest) status.textContent = '无法播放该素材，请检查本地音频服务后重试。';
  }
}

function drawScore() {
  const arm = data.variants[variant];
  const project = { ...arm.project, title: '', composer: '' };
  const lead = project.parts.filter(part => part.role === 'lead').map(part => part.id);
  const partIds = lead.length ? lead : project.parts.slice(0, 1).map(part => part.id);
  scoreWidth = score.clientWidth;
  element('score-title').textContent = labels[variant];
  element('projection').hidden = variant !== 'raw';
  variantButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.variant === variant)));
  if (variant === 'raw') {
    // Seconds are not note values. Keep the raw arm visually honest instead
    // of creating arbitrary tuplets by passing continuous time to engraving.
    const start = passage.firstBar * 4;
    const end = (passage.lastBar + 1) * 4;
    const notes = project.parts.filter(part => partIds.includes(part.id)).flatMap(part => part.notes)
      .filter((note): note is typeof note & { midi: number } => note.midi !== null)
      .filter(note => note.start < end && note.start + note.duration > start);
    const low = Math.min(55, ...notes.map(note => note.midi));
    const high = Math.max(72, ...notes.map(note => note.midi));
    const width = Math.max(320, scoreWidth);
    const height = (high - low + 1) * 13 + 40;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '原始 Medium 音高与起止时间');
    const shape = (tag: string, attrs: Record<string, string | number>, text?: string) => {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      if (text) node.textContent = text;
      svg.append(node);
    };
    const x = (beat: number) => 42 + (beat - start) / (end - start) * (width - 54);
    for (let midi = low; midi <= high; midi++) {
      const y = 26 + (high - midi) * 13;
      shape('line', { x1: 42, x2: width - 12, y1: y + 6, y2: y + 6, stroke: '#e4e7e5' });
      if (midi % 12 === 0 || midi === low || midi === high) {
        const name = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][midi % 12];
        shape('text', { x: 2, y: y + 10, 'font-size': 11, fill: '#626d69' }, `${name}${Math.floor(midi / 12) - 1}`);
      }
    }
    for (let beat = start; beat <= end; beat += 4) {
      shape('line', { x1: x(beat), x2: x(beat), y1: 22, y2: height - 10, stroke: '#aeb7b1' });
      if (beat < end) shape('text', { x: x(beat) + 4, y: 16, 'font-size': 12 }, String(beat / 4));
    }
    for (const note of notes) shape('rect', {
      x: x(Math.max(start, note.start)), y: 26 + (high - note.midi) * 13,
      width: Math.max(1, x(Math.min(end, note.start + note.duration)) - x(Math.max(start, note.start))),
      height: 10, rx: 2, fill: '#527365',
    });
    score.replaceChildren(svg);
    return;
  }
  const result = toAbc(project, partIds, {
    barsPerSystem: 2,
    measureRange: { start: passage.firstBar + 1, end: passage.lastBar + 1 },
    measureNumberOffset: -1,
  });
  abcjs.renderAbc(score, result.abc, {
    staffwidth: Math.max(260, scoreWidth - 24),
    responsive: 'resize',
    oneSvgPerLine: true,
    add_classes: true,
    afterParsing: tune => prepareEngravingTune(tune, result),
  });
  fitEngravingSystems([...score.querySelectorAll('svg')]);
}

function drawReference() {
  const scans = element('scans');
  scans.replaceChildren();
  if (!reference.open) return;
  const pages = data.referencePages.filter(page => page.firstBar <= passage.lastBar && page.lastBar >= passage.firstBar);
  for (const page of pages) {
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    const image = document.createElement('img');
    caption.textContent = bars(page);
    image.alt = `原版手扒谱${bars(page)}`;
    image.loading = 'lazy';
    image.src = assetUrl(page.url);
    image.addEventListener('error', () => { caption.textContent = `${bars(page)}，参考图未能加载`; }, { once: true });
    figure.append(caption, image);
    scans.append(figure);
  }
  if (!pages.length) scans.textContent = '这段没有可用的参考谱页。';
}

function showSaveState() {
  exportButton.disabled = ![...drafts.values()].some(draft => draft.preferred || draft.comment.trim());
  element('save-state').textContent = unsaved.has(passage.firstBar)
    ? '这段暂存在当前页面，刷新前可先导出。'
    : drafts.has(passage.firstBar) ? '这段已保存在此浏览器。' : '输入会保存在此浏览器。';
}

function saveDraft() {
  const preferred = (verdicts.find(input => input.checked)?.value ?? '') as Verdict;
  const draft = { preferred, comment: comment.value, updatedAt: new Date().toISOString() };
  drafts.set(passage.firstBar, draft);
  try {
    localStorage.setItem(draftKey(passage), JSON.stringify(draft));
    unsaved.delete(passage.firstBar);
  } catch {
    unsaved.add(passage.firstBar);
  }
  showSaveState();
}

function selectPassage(next: Passage) {
  pause();
  passage = next;
  position.min = String(passage.startSeconds);
  position.max = String(passage.endSeconds);
  cursor = passage.startSeconds;
  updateAudio();
  for (const button of element('windows').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.firstBar === String(passage.firstBar)));
  }
  const draft = drafts.get(passage.firstBar);
  comment.value = draft?.comment ?? '';
  for (const input of verdicts) input.checked = input.value === draft?.preferred;
  showSaveState();
  drawScore();
  drawReference();
}

function exportReview() {
  const records = data.windows.flatMap(({ firstBar, lastBar }) => {
    const draft = drafts.get(firstBar);
    return draft && (draft.preferred || draft.comment.trim()) ? [{ firstBar, lastBar, ...draft }] : [];
  });
  const blob = new Blob([JSON.stringify({ experimentId: data.id, records }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '空耳-歌词辅助审阅.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

try {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`素材服务返回 ${response.status}`);
  data = await response.json() as Manifest;
  if (!data.id || !data.windows.length || data.windows.some(window =>
    !Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds) ||
    window.startSeconds < 0 || window.endSeconds <= window.startSeconds || window.endSeconds > data.duration + 0.05
  )) throw new Error('片段时间无效');

  for (const key of Object.keys(labels) as Variant[]) labels[key] = data.variants[key].title;
  for (const button of variantButtons) button.textContent = labels[button.dataset.variant as Variant];
  for (const input of verdicts) {
    if (input.value in labels && input.nextSibling) input.nextSibling.textContent = labels[input.value as Variant];
  }

  for (const window of data.windows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = bars(window);
    button.dataset.firstBar = String(window.firstBar);
    button.onclick = () => selectPassage(window);
    element('windows').append(button);
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey(window)) ?? 'null') as Draft | null;
      if (saved && typeof saved.comment === 'string' && typeof saved.updatedAt === 'string' &&
        ['', 'raw', 'current', 'lyrics', 'unsure'].includes(saved.preferred)) drafts.set(window.firstBar, saved);
    } catch { /* A missing or unreadable local draft leaves the passage unreviewed. */ }
  }

  for (const button of variantButtons) button.onclick = () => {
    pauseAtCursor();
    variant = button.dataset.variant as Variant;
    source = 'variant';
    updateAudio();
    drawScore();
  };
  for (const button of sourceButtons) button.onclick = () => {
    pauseAtCursor();
    source = button.dataset.source as AudioSource;
    updateAudio();
  };

  audio.addEventListener('loadedmetadata', () => seek(cursor));
  audio.addEventListener('play', () => { play.textContent = '暂停'; });
  audio.addEventListener('pause', () => { play.textContent = '播放'; });
  audio.addEventListener('ended', () => { play.textContent = '播放'; });
  audio.addEventListener('playing', trackPlayback);
  audio.addEventListener('seeked', trackPlayback);
  audio.addEventListener('timeupdate', trackPlayback);
  audio.addEventListener('waiting', () => window.clearTimeout(stopTimer));
  audio.addEventListener('error', () => { status.textContent = '未能读取此音频素材。'; });
  position.oninput = () => seek(position.valueAsNumber);
  play.onclick = () => void togglePlayback();
  reference.ontoggle = drawReference;
  comment.oninput = saveDraft;
  verdicts.forEach(input => { input.onchange = saveDraft; });
  exportButton.onclick = exportReview;
  window.addEventListener('pagehide', pause);

  for (const note of data.notes) {
    const item = document.createElement('li');
    item.textContent = note;
    element('notes-list').append(item);
  }
  element('notes').hidden = !data.notes.length;
  review.hidden = false;
  selectPassage(data.windows.find(window => window.firstBar === 13) ?? data.windows[0]);
  new ResizeObserver(() => { if (score.clientWidth !== scoreWidth) drawScore(); }).observe(score);
} catch (error) {
  review.hidden = true;
  status.textContent = `无法打开本地对照素材。${error instanceof Error ? error.message : ''}`;
}
