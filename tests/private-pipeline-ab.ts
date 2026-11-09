import abcjs from 'abcjs';
import { toAbc } from '../src/lib/music';
import { fitEngravingSystems, prepareEngravingTune, alignEngravingStaffNames } from '../src/lib/engraving';
import { renderProjectAudio } from '../src/lib/audio';
import { candidateSideFor, stringEnsembleView, readableLayout, reviewSummary, decodeReviewRecords,
  PRESENTATION_VERSION, LAYOUT_VERSION, type ExperimentStage, type ReviewRecord } from '../src/lib/pipelineExperiment';
import type { ScoreProject } from '../src/lib/types';

type Manifest = { id: string; duration: number; grid: { bpm: number; offsetSeconds: number };
  baseline: ScoreProject; candidate: ScoreProject; ensembleSource: ScoreProject;
  originalUrl: string; stemUrl: string; baselineUrl: string; candidateUrl: string; rawUrl: string;
  summary: { baseline: Record<string, number>; candidate: Record<string, number> };
  audit: { version: string; changes: Array<{ sourceStartSeconds: number; scoreStartSeconds: number }> };
};
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const windows = element<HTMLSelectElement>('window'), scope = element<HTMLSelectElement>('scope');
const original = element<HTMLAudioElement>('original'), stem = element<HTMLAudioElement>('stem');
const player = element<HTMLAudioElement>('score-audio'), rawPlayer = element<HTMLAudioElement>('raw-audio');
const players = [original, stem, player, rawPlayer];
const status = element('status'), saveState = element('save-state');
const pages = [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 44, 48, 52, 56, 59, 62, 66, 70];
let stage: ExperimentStage = 'vocal', side: 'A' | 'B' = 'A';
let data: Manifest, experimentId = '', key = '', records: ReviewRecord[] = [], revealSeen = false;
let start = 0, end = 0, audioOrigin = 0, generation = 0, stopTimer = 0, renderedUrl = '', audioKey = '';
let renderingAudio = false;
const rawStored = () => { try { return decodeReviewRecords(localStorage.getItem(key)); } catch { return []; } };
const selected = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
const setStatus = (message: string) => { status.textContent = message; };
const pause = () => { clearTimeout(stopTimer); players.forEach(p => p.pause()); };
const bounds = (p: HTMLAudioElement) => [start, end].map(t => t - (p === player ? audioOrigin : 0));
function scheduleStop(p: HTMLAudioElement) {
  clearTimeout(stopTimer);
  if (!p.paused) stopTimer = window.setTimeout(() => {
    if (p.currentTime >= bounds(p)[1] - .01) p.pause(); else scheduleStop(p);
  }, Math.max(25, (bounds(p)[1] - p.currentTime) * 1000));
}
for (const p of players) {
  p.addEventListener('loadedmetadata', () => { p.currentTime = Math.max(0, bounds(p)[0]); });
  p.addEventListener('play', () => {
    players.filter(other => other !== p).forEach(other => other.pause());
    const [a, b] = bounds(p);
    if (p.currentTime < a || p.currentTime >= b) p.currentTime = Math.max(0, a);
    scheduleStop(p);
  });
  p.addEventListener('seeked', () => scheduleStop(p));
  p.addEventListener('timeupdate', () => { if (p.currentTime >= bounds(p)[1]) p.pause(); });
  p.addEventListener('error', () => setStatus('音频未能加载。请确认本地素材服务仍在运行；当前试听不能计为已完成。'));
}
function focusedIds(project: ScoreProject): string[] {
  if (scope.value === 'full') return project.parts.map(p => p.id);
  return project.parts.filter(p => stage === 'strings'
    ? [40, 41, 42, 43, 44, 45, 46, 48, 49, 50, 51].includes(p.program) && p.role === 'instrument'
    : p.role === 'lead').map(p => p.id);
}
function projects() {
  if (stage === 'vocal') {
    if (scope.value === 'focus') return { baseline: data.baseline, candidate: data.candidate };
    const withVocal = (vocal: ScoreProject) => ({ ...data.ensembleSource, parts: data.ensembleSource.parts
      .map(p => p.role === 'lead' ? { ...vocal.parts[0], id: p.id } : p) });
    return { baseline: withVocal(data.baseline), candidate: withVocal(data.candidate) };
  }
  if (stage === 'strings') return { baseline: data.ensembleSource,
    candidate: stringEnsembleView(data.ensembleSource, data.ensembleSource.parts.map(p => p.id)).project };
  return { baseline: data.ensembleSource, candidate: data.ensembleSource };
}
function progress() {
  const result = reviewSummary(records, experimentId, stage);
  element('progress').textContent = `已审 ${result.reviewed} 段`;
}
function restoreReview() {
  document.querySelectorAll<HTMLInputElement>('#review input').forEach(input => input.checked = false);
  element<HTMLTextAreaElement>('comment').value = '';
  saveState.textContent = '';
  const prior = [...records].reverse().find(r => r.experimentId === experimentId && r.stage === stage
    && r.firstBar === Number(windows.value) && r.scope === scope.value);
  if (!prior) return;
  document.querySelector<HTMLInputElement>(`input[name="preferred"][value="${prior.preferred}"]`)!.checked = true;
  document.querySelector<HTMLInputElement>(`input[name="confidence"][value="${prior.confidence}"]`)!.checked = true;
  document.querySelectorAll<HTMLInputElement>('input[name="problem"]').forEach(input => input.checked = prior.problems.includes(input.value));
  element<HTMLTextAreaElement>('comment').value = prior.comment;
  saveState.textContent = '已恢复这段的审阅记录';
}
function reference() {
  const container = element('scans'); container.replaceChildren();
  if (!element<HTMLDetailsElement>('reference').open) return;
  const first = Number(windows.value);
  pages.forEach((bar, index) => {
    if (bar > Math.min(70, first + 3) || (pages[index + 1] ?? 71) <= first) return;
    const img = document.createElement('img');
    img.src = `http://127.0.0.1:8788/reference/${String(index + 1).padStart(2, '0')}.png`;
    img.alt = `原版手扒谱第 ${index + 1} 页`; img.loading = 'lazy'; container.append(img);
  });
}
function draw() {
  const first = Number(windows.value), candidateSide = candidateSideFor(experimentId, stage, first);
  const isCandidate = side === candidateSide;
  const pair = projects(), project = isCandidate ? pair.candidate : pair.baseline;
  const p = { ...project, title: '', composer: '', parts: project.parts.map(part =>
    stage === 'vocal' && part.role === 'lead' ? { ...part, name: '人声', shortName: '人声' } : part) };
  const range = { start: first + 1, end: Math.min(project.measures, first + 4, 71) };
  let partIds = focusedIds(project);
  if (!partIds.length) partIds = [project.parts[0].id];
  const width = Math.max(320, element('score').clientWidth - 30);
  const layout = stage === 'layout' && isCandidate ? readableLayout(p, range, partIds, width)
    : { visiblePartIds: partIds, barsPerSystem: 4, staffSep: 37, systemSep: 34, hiddenRestingParts: 0 };
  const result = toAbc(p, layout.visiblePartIds, { ...layout, measureRange: range, measureNumberOffset: -1 });
  abcjs.renderAbc(element('score'), result.abc, { staffwidth: width, responsive: 'resize',
    oneSvgPerLine: true, add_classes: true, afterParsing: tune => prepareEngravingTune(tune, result) });
  const systems = [...element('score').querySelectorAll<SVGSVGElement>('svg')];
  if (stage === 'layout' && isCandidate) alignEngravingStaffNames(systems);
  fitEngravingSystems(systems);
  for (const label of ['a', 'b']) element('side-' + label).setAttribute('aria-pressed', String(side.toLowerCase() === label));
  element('version-map').textContent = `${candidateSide} 是候选；${candidateSide === 'A' ? 'B' : 'A'} 是冻结基线。`;
  const baselineCount = pair.baseline.parts.reduce((sum, p) => sum + p.notes.length, 0);
  const candidateCount = pair.candidate.parts.reduce((sum, p) => sum + p.notes.length, 0);
  element('stats').textContent = stage === 'vocal'
    ? `同一份 Medium：${data.summary.baseline.notes} 个音，音高和数量未变。短于十六分音符：${data.summary.baseline.shorterThanSixteenth} → ${data.summary.candidate.shorterThanSixteenth}；短于三十二分音符：${data.summary.baseline.shorterThanThirtySecond} → ${data.summary.candidate.shorterThanThirtySecond}。这些计数不是准确率。`
    : stage === 'strings' ? `全曲音符 ${baselineCount} → ${candidateCount}；只改阅读分组。竖琴单独保留，真实同音重叠不删除。A/B 使用同一份回放。`
    : `同一语义谱、同一份回放。候选按密度换行、增加谱表间距、对齐谱表名称，并隐藏本窗口全休止的声部。`;
  element('methods').textContent = `实验 ${experimentId.slice(0, 12)}\n${stage === 'vocal' ? data.audit.version : stage === 'strings' ? PRESENTATION_VERSION : LAYOUT_VERSION}\nA/B 顺序按片段固定打散；外观不同的实验无法完全盲测。结果不会自动晋升。\n同一首歌的相邻片段不是独立样本，审阅比例不解释为统计显著性。`;
}
function render() {
  pause(); generation++; audioKey = ''; player.removeAttribute('src'); player.load(); player.hidden = true;
  if (renderedUrl) { URL.revokeObjectURL(renderedUrl); renderedUrl = ''; }
  audioOrigin = 0; element('audio-state').textContent = ''; setStatus('');
  document.querySelectorAll<HTMLElement>('[data-stage]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.stage === stage)));
  const first = Number(windows.value), secondsPerBeat = 60 / data.grid.bpm;
  start = Math.max(0, data.grid.offsetSeconds + first * 4 * secondsPerBeat);
  end = first === 69 ? data.duration : Math.min(data.duration, start + 16 * secondsPerBeat);
  element('clock').textContent = `${start.toFixed(1)}～${end.toFixed(1)} 秒`;
  original.currentTime = start;
  rawPlayer.currentTime = start;
  element('raw-evidence').hidden = stage !== 'vocal';
  const stemUrl = stage === 'vocal' ? data.stemUrl : 'http://127.0.0.1:8788/other.wav';
  if (stem.getAttribute('src') !== stemUrl) stem.src = stemUrl; else stem.currentTime = start;
  element('stem-label').textContent = stage === 'vocal' ? '人声分轨' : '伴奏混合轨';
  element('instruction').textContent = stage === 'vocal'
    ? '先听原声，再切换 A/B。重点检查同音重唱、短音、换气和节奏，别只看哪版更整齐。'
    : stage === 'strings' ? 'A/B 的音符与回放相同。检查合奏归组后，长音、和弦和独立线条是否更容易追踪。'
    : 'A/B 使用同一份总谱和回放。检查正常尺寸下的符号重叠、换行和阅读负担。';
  element('question').textContent = stage === 'vocal' ? '哪一版更容易照着唱，且没有丢掉原声里的内容？' : '哪一版更容易读，且没有遮住或混淆音乐线条？';
  element<HTMLButtonElement>('previous').disabled = windows.selectedIndex === 0;
  element<HTMLButtonElement>('next').disabled = windows.selectedIndex === windows.options.length - 1;
  element<HTMLDetailsElement>('reveal').open = false; revealSeen = false;
  draw(); reference(); restoreReview(); progress();
}
async function listen(requested: 'A' | 'B') {
  if (renderingAudio) return;
  pause(); side = requested; draw();
  const version = generation, candidate = requested === candidateSideFor(experimentId, stage, Number(windows.value));
  const wanted = `${generation}:${stage === 'vocal' ? requested : 'shared'}`;
  try {
    if (audioKey !== wanted) {
      if (stage === 'vocal') {
        audioOrigin = 0;
        player.src = candidate ? data.candidateUrl : data.baselineUrl;
      } else {
        renderingAudio = true;
        element<HTMLButtonElement>('listen-a').disabled = true;
        element<HTMLButtonElement>('listen-b').disabled = true;
        setStatus('正在生成这一段的共同回放…');
        const p = structuredClone(data.ensembleSource), first = Number(windows.value), a = first * 4, b = a + 16;
        const ids = focusedIds(p);
        p.parts = p.parts.filter(part => ids.includes(part.id)).map(part => ({ ...part,
          notes: part.notes.filter(n => n.start < b && n.start + n.duration > a).map(n => ({ ...n,
            start: Math.max(a, n.start) - a, duration: Math.min(b, n.start + n.duration) - Math.max(a, n.start),
            ...(n.start < a ? { arpeggio: false, arpeggioOffset: undefined } : {}) })) }));
        p.measures = 4; p.chords = []; delete p.originalAudio;
        const rendered = await renderProjectAudio(p);
        if (generation !== version) return;
        if (renderedUrl) URL.revokeObjectURL(renderedUrl);
        renderedUrl = URL.createObjectURL(new Blob([Uint8Array.from(rendered.bytes)], { type: 'audio/wav' }));
        audioOrigin = start; player.src = renderedUrl;
      }
      audioKey = wanted;
    }
    player.hidden = false; player.currentTime = Math.max(0, start - audioOrigin);
    element('audio-state').textContent = stage === 'vocal' ? `${requested} · 人声谱面回放` : 'A/B 共用同一回放';
    await player.play(); setStatus('');
  } catch (e) { if (version === generation) setStatus(`回放未完成：${String(e)}`); }
  finally {
    renderingAudio = false;
    element<HTMLButtonElement>('listen-a').disabled = false;
    element<HTMLButtonElement>('listen-b').disabled = false;
  }
}

try {
  const response = await fetch('http://127.0.0.1:8788/review.json');
  if (!response.ok) throw Error('实验素材未生成，请运行 scripts/build-pipeline-ab.py');
  data = await response.json();
  experimentId = `${data.id}:${PRESENTATION_VERSION}:${LAYOUT_VERSION}`;
  key = `coro-pipeline-review:${experimentId}`; records = rawStored();
  windows.replaceChildren();
  for (let first = 1; first <= 70; first += 4) windows.add(new Option(`第 ${first}～${Math.min(70, first + 3)} 小节${first === 69 ? '＋尾声' : ''}`, String(first)));
  windows.value = '13'; original.src = data.originalUrl; rawPlayer.src = data.rawUrl;
  windows.onchange = render; scope.onchange = render;
  element('previous').onclick = () => { windows.selectedIndex = Math.max(0, windows.selectedIndex - 1); render(); };
  element('next').onclick = () => { windows.selectedIndex = Math.min(windows.options.length - 1, windows.selectedIndex + 1); render(); };
  document.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach(button => button.onclick = () => {
    stage = button.dataset.stage as ExperimentStage;
    document.querySelectorAll<HTMLElement>('[data-stage]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    scope.value = stage === 'layout' ? 'full' : 'focus'; render();
  });
  for (const requested of ['A', 'B'] as const) {
    element(`side-${requested.toLowerCase()}`).onclick = () => { pause(); side = requested; draw(); };
    element(`listen-${requested.toLowerCase()}`).onclick = () => void listen(requested);
  }
  element<HTMLDetailsElement>('reference').ontoggle = reference;
  element<HTMLDetailsElement>('reveal').ontoggle = () => { if (element<HTMLDetailsElement>('reveal').open) revealSeen = true; };
  element('save').onclick = () => {
    const preferred = selected('preferred'), confidence = selected('confidence');
    if (!preferred || !confidence) { saveState.textContent = '请先选择这段的判断和把握程度。'; return; }
    const record: ReviewRecord = { experimentId, stage, firstBar: Number(windows.value), scope: scope.value as 'focus' | 'full',
      candidateSide: candidateSideFor(experimentId, stage, Number(windows.value)),
      preferred: preferred.value as ReviewRecord['preferred'], confidence: confidence.value as ReviewRecord['confidence'],
      problems: [...document.querySelectorAll<HTMLInputElement>('input[name="problem"]:checked')].map(x => x.value),
      comment: element<HTMLTextAreaElement>('comment').value.trim(), reviewedAt: new Date().toISOString(),
      reviewedBy: 'human', revealed: revealSeen };
    try {
      records = [...rawStored(), record]; localStorage.setItem(key, JSON.stringify(records));
      saveState.textContent = '已保存；切换片段可继续审阅。'; progress();
    } catch { saveState.textContent = '浏览器保存失败，请立即导出，避免丢失这次判断。'; }
  };
  element('export').onclick = () => {
    const report = { experimentId, exportedAt: new Date().toISOString(), automaticPromotion: false,
      summaries: Object.fromEntries((['vocal', 'strings', 'layout'] as const).map(s => [s, reviewSummary(records, experimentId, s)])), records };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = '空耳-pipeline-审阅.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(draw, 100); });
  window.addEventListener('pagehide', () => { pause(); if (renderedUrl) URL.revokeObjectURL(renderedUrl); });
  render();
} catch (e) { setStatus(String(e)); }
