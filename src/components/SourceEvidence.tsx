import { useEffect, useState } from 'react';
import { ArrowDown, ArrowSquareOut, CaretDown, FileText, Info } from '@phosphor-icons/react';
import type { ScoreProject } from '../lib/types';
import { downloadFile, parseProject } from '../lib/storage';
import { resolveLocalAsset } from '../lib/projectBundle';
import { Headphones } from '@phosphor-icons/react';
import { pitchVerificationSummary } from '../lib/verificationSummary';
import { VOCAL_INPUT_LABELS, type VocalInputChoice } from '../lib/vocalRebuild';
import { pitchEvidenceJobId } from '../lib/pitchReview';
import { pipelineStatus } from '../lib/provenance';

type PipelineManifest = {
  timeline: Array<{ stage: string; label: string; layer: string; seconds: number | null }>;
  components: Record<string, string | string[]>;
  runtime?: { revision?: string; codeHash?: string } | null;
  outputs?: { leadNotationVersion?: string; scoreQuantizerVersion?: string };
};

const LAYER_LABELS: Record<string, string> = {
  input: '输入',
  recognition: '识别',
  notation: '记谱推断',
  presentation: '声部呈现',
  layout: '排版',
  unclassified: '其他',
};

export default function SourceEvidence({
  project,
  onImportCopy,
  onMessage,
  onSeek,
  onAudio,
  onPitchReview,
  onVocalRebuild,
  onReanalyze,
}: {
  project: ScoreProject;
  onImportCopy: (project: ScoreProject) => Promise<boolean>;
  onMessage: (message: string, error?: boolean) => void;
  onSeek?: (seconds: number) => void;
  onAudio?: (url: string, name: string) => void;
  onPitchReview?: (seconds: number) => void;
  onVocalRebuild?: () => void;
  /** Re-transcribe this song with the current pipeline (opens the import dialog). */
  onReanalyze?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [pageUrl, setPageUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Keyed by job, so switching projects never shows or suppresses another job's record.
  const [pipelineState, setPipelineState] = useState<{ job: string; value: PipelineManifest | null }>();
  const analysis = project.source.analysis;
  const displayedTransforms = [...new Set((analysis?.transforms ?? []).map((text) =>
    text.replace(/^(前序版本记录：)+/, '前序版本记录：'),
  ))];
  const verification = pitchVerificationSummary(analysis);
  const multiscore = analysis?.quality?.decoderProfile === 'yourmt3';
  const inputChoice = analysis?.quality?.vocalInputSource;
  const inputLabel = typeof inputChoice === 'string' ? VOCAL_INPUT_LABELS[inputChoice as VocalInputChoice] : undefined;
  const currentInput = project.parts.find((part) => part.id === 'vocals')?.stemUrl;
  const pages = project.source.pages ?? [];
  const rawUrl = analysis?.rawProjectUrl;
  const evidenceJobId = pitchEvidenceJobId(project);
  const nativeJob = analysis?.quality?.nativeEventsJobId;
  const nativeJobId = typeof nativeJob === 'string' && /^[a-f0-9]{32}$/.test(nativeJob) ? nativeJob : undefined;
  const learnedDecoder = analysis?.quality?.decoderProfile === 'phoneme' || analysis?.quality?.decoderProfile === 'rosvot';
  const modelEvidenceUrl = analysis?.quality?.modelEvidenceUrl;
  const modelJobId = typeof modelEvidenceUrl === 'string' ? modelEvidenceUrl.match(/^\/api\/projects\/([a-f0-9]{32})\/evidence$/)?.[1] : undefined;
  const rhythmJobId = learnedDecoder && !analysis?.quality?.scoreRebuildFromJob
    ? modelJobId ?? evidenceJobId : nativeJobId ?? evidenceJobId;
  const rebuildScore = async () => {
    if (!rhythmJobId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${rhythmJobId}/score-rhythm`, { method: 'POST' });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || '本机识别缓存不可用，无法重新整理节奏。');
      }
      if (await onImportCopy(parseProject(await response.text())))
        onMessage('已打开新的节奏整理谱本；之前的编辑稿保存在工程库。');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '总谱节奏整理失败', true);
    } finally {
      setBusy(false);
    }
  };
  const identityTracks = [
    ['leadAudioUrl', '主唱分支'],
    ['backingAudioUrl', '伴唱分支'],
  ] as const;
  const listenBranch = async (url: string, name: string) => {
    try {
      onAudio?.(await resolveLocalAsset(url), name);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '本地分支音频读取失败', true);
    }
  };
  useEffect(() => {
    setPage(0);
    setPageUrl(undefined);
  }, [project.id]);
  useEffect(() => {
    let live = true;
    const selected = pages[page];
    if (!selected) {
      setPageUrl(undefined);
      return;
    }
    void resolveLocalAsset(selected)
      .then((url) => {
        if (live) setPageUrl(url);
      })
      .catch((error) => onMessage(error instanceof Error ? error.message : '原谱页无法读取', true));
    return () => {
      live = false;
    };
  }, [pages[page], page]);
  // Every hook runs before the early return; hook order must not depend on the project.
  const pipeline = pipelineState && pipelineState.job === evidenceJobId ? pipelineState.value : undefined;
  useEffect(() => {
    if (!expanded || !evidenceJobId || pipelineState?.job === evidenceJobId) return;
    let live = true;
    fetch(`/api/projects/${evidenceJobId}/pipeline`)
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => live && setPipelineState({ job: evidenceJobId, value }))
      .catch(() => live && setPipelineState({ job: evidenceJobId, value: null }));
    return () => {
      live = false;
    };
  }, [expanded, evidenceJobId, pipelineState?.job]);
  if (!analysis && !pages.length) return null;
  const getRaw = async (open: boolean) => {
    if (!rawUrl || !/^\/api\/projects\/[a-f0-9]{32}\/(?:raw|game-raw)$/.test(rawUrl)) return;
    setBusy(true);
    try {
      const response = await fetch(rawUrl);
      if (!response.ok) throw new Error('原始转写未找到，请检查原任务是否仍在本机。');
      const text = await response.text();
      if (open) {
        const raw = parseProject(text);
        raw.id = crypto.randomUUID();
        raw.title += ' · 原始模型副本';
        if (await onImportCopy(raw))
          onMessage('已打开原始模型副本；之前工程保存在工程库。');
      } else
        downloadFile(
          text,
          `${project.title.replace(/[\\/:*?"<>|]/g, '-')}-raw.coro.json`,
          'application/json',
        );
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '读取原始转写失败', true);
    } finally {
      setBusy(false);
    }
  };
  const getEvidence = async () => {
    if (!evidenceJobId) return;
    try {
      const response = await fetch(`/api/projects/${evidenceJobId}/evidence`);
      if (!response.ok) throw new Error('模型证据在本机尚不可用。');
      downloadFile(await response.blob(), 'model-disagreements.json', 'application/json');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '读取模型证据失败', true);
    }
  };
  const provenance = pipelineStatus(project);
  return (
    <section className={`source-evidence ${expanded ? 'expanded' : ''}`}>
      {provenance.kind === 'legacy' && (
        <div className="legacy-pipeline" role="status">
          <Info size={15} />
          <span>
            这份转写来自<b>{provenance.reason}</b>，不是当前 v5 流水线（YourMT3+ 多声部 + GAME 主唱 + 新版钢琴记谱）。谱面、琶音和声部分配都会不同。
          </span>
          {onReanalyze && (
            <button className="text-button" onClick={onReanalyze}>
              用当前流水线重新转写
            </button>
          )}
        </div>
      )}
      <div className="source-evidence-bar">
        <button
          className="evidence-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {pages.length ? <FileText size={16} /> : <Info size={16} />}
          <span>{pages.length ? `原谱对照 · ${pages.length} 页` : '转写修正提案'}</span>
          {analysis?.uncertaintyIntervals?.length ? (
            <b className="uncertainty-count">{analysis.uncertaintyIntervals.length} 段待定</b>
          ) : null}
          <CaretDown size={13} />
        </button>
        <span className="evidence-summary">
          {analysis?.rhythm
            ? `${analysis.rhythm.bpm.toFixed(1)} BPM · ${displayedTransforms.length} 项处理，${rawUrl ? '原始结果保留' : '提案来源记录'}`
            : project.source.engine}
        </span>
        {rawUrl && (
          <button className="text-button" disabled={busy} onClick={() => void getRaw(false)}>
            <ArrowDown size={14} />
            原始转写
          </button>
        )}
        {onVocalRebuild && analysis?.quality?.decoderProfile !== 'game' && (
          <button className="text-button" onClick={onVocalRebuild} title="复用已分离主唱，另存一份节奏重建结果；其他声部不变">
            重建主唱节奏
          </button>
        )}
        {rhythmJobId && analysis?.quality?.decoderProfile !== 'game' && (multiscore || (analysis?.quality?.vocalRhythmVersion && currentInput)) && (
          <button className="text-button" disabled={busy} onClick={() => void rebuildScore()}
            title="复用本机原始识别缓存，另存新谱；当前编辑稿保留">
            {busy ? '正在整理…' : multiscore ? '重新整理总谱节奏' : '重新整理主唱节奏'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="source-evidence-body">
          {analysis?.quality?.decoderProfile === 'rosvot' && (
            <div className="pitch-verification">
              <strong>主唱：词音边界 + 联合节奏</strong>
              <p>先辨识演唱中的词与音符边界，再整理相邻起止。没有按固定短时值删掉快速音；原始模型音符仍保留在证据中，歌词未识别。</p>
              <p>下方 FCPE / CREPE 曲线来自独立音高模型，便于对照原声，不是这份主唱谱的正确率。</p>
              {inputLabel && <p>本次转写输入：{inputLabel}。更换输入不代表已确认主唱身份。</p>}
              {inputLabel && currentInput && /^(?:\/api\/audio\/[a-f0-9]{32}\/stem-(?:lead|vocals)\.wav|local:bundle-[a-f0-9-]+)$/.test(currentInput) && (
                <button className="secondary-button" onClick={() => void listenBranch(currentInput, inputLabel)}><Headphones size={16} />听本次转写输入</button>
              )}
              {typeof analysis.quality.vocalAlignedBoundaries === 'number' && analysis.quality.vocalAlignmentVersion !== 'not_available' && (
                <p>已按原声的音高进入、收音和再起音对齐 {analysis.quality.vocalAlignedBoundaries} 处边界；没有给整曲统一加延迟，也没有因此增加或删除音符。</p>
              )}
              {analysis.quality.vocalAlignmentVersion === 'not_available' && (
                <p>本机缺少可用于起止对齐的连续音高，本次保留词音模型的时序。</p>
              )}
            </div>
          )}
          {verification && !multiscore && (
            <div className="pitch-verification">
              <strong>{verification.title}</strong>
              <p>{verification.detail}</p>
            </div>
          )}
          {identityTracks.some(([key]) => typeof analysis?.quality?.[key] === 'string') && (
            <div className="identity-track-buttons">
              {identityTracks.map(([key, label]) => {
                const url = analysis?.quality?.[key];
                return typeof url === 'string' &&
                  (/^\/api\/audio\/[a-f0-9]{32}\/stem-(?:lead|backing)\.wav$/.test(url) ||
                    /^local:bundle-[a-f0-9-]+$/.test(url)) ? (
                  <button
                    className="secondary-button"
                    key={key}
                    onClick={() => void listenBranch(url, label)}
                  >
                    <Headphones size={16} />听{label}
                  </button>
                ) : null;
              })}
              <p>主唱 / 伴唱是模型分支，不是已确认身份。选择后从底部播放栏试听，原混合人声仍在原始结果中。</p>
            </div>
          )}
          {analysis?.uncertaintyIntervals?.length ? (
            <section className="uncertain-intervals">
              <strong>{multiscore ? '这些段落的音符或乐器归属仍待核对' : '这些段落仍有主唱 / 八度分歧'}</strong>
              {analysis.uncertaintyIntervals.map((interval, index) => (
                <button key={index} title={interval.reason} onClick={() => onSeek?.(interval.startSeconds)}>
                  <span>
                    {interval.startSeconds.toFixed(1)}–{interval.endSeconds.toFixed(1)} 秒
                  </span>
                  {/CREPE|FCPE/.test(interval.reason)
                    ? '独立音高模型在此处有明显音高 / 八度分歧，需要试听校正。'
                    : interval.reason}
                  <ArrowSquareOut size={13} />
                </button>
              ))}
              <p>点击定位原音频。未标注不代表逐音正确；低发声证据和静音帧不计入验证成功。</p>
            </section>
          ) : null}
          {analysis && (
            <>
              <p>
                这是带编辑取舍的谱面提案，不是已验证的原版总谱。
                {rawUrl
                  ? '可打开原始模型结果对照；生成或修正没有覆盖原音频。'
                  : evidenceJobId
                  ? '基础模型没有可打开的总谱；原音频与详细模型证据仍可用于校对。'
                  : '此工程保留处理说明；原始模型结果与详细模型证据需在原工作台另行保存，不在此便携工程中。'}
              </p>
              {analysis.quality?.vocalRebuildFromJob && <p>以下包含旧版本的处理记录；当前输入以本次重建说明为准。</p>}
              <ul>
                {displayedTransforms.map((transform, index) => (
                  <li key={index}>{transform}</li>
                ))}
              </ul>
              {pipeline && (
                <section className="pipeline-trace" aria-label="本次实际运行流程">
                  <strong>本次实际流程</strong>
                  <ol>
                    {pipeline.timeline
                      .filter((span) => !['queued', 'complete'].includes(span.stage))
                      .map((span, index) => (
                        <li key={index} data-layer={span.layer}>
                          <span>{span.label}</span>
                          <em>{LAYER_LABELS[span.layer] ?? span.layer}</em>
                          {span.seconds !== null && <small>{Math.round(span.seconds)} 秒</small>}
                        </li>
                      ))}
                  </ol>
                  <p>
                    代码 {pipeline.runtime?.revision ?? '未知'} · 主唱记谱{' '}
                    {pipeline.outputs?.leadNotationVersion ?? '—'} · 伴奏记谱 {pipeline.outputs?.scoreQuantizerVersion ?? '—'}
                    。这里记录的是来源和版本，不代表音乐正确性。
                  </p>
                </section>
              )}
              {analysis.rhythm && (
                <p>
                  节拍来源：{analysis.rhythm.method}；第 1 拍相对原音频{' '}
                  {analysis.rhythm.offsetSeconds.toFixed(3)} 秒。节拍置信度并非转谱准确率。
                </p>
              )}
              {evidenceJobId && (
                <div className="note-actions">
                  {onPitchReview && project.source.kind === 'audio' && !['yourmt3', 'game'].includes(String(analysis.quality?.decoderProfile)) && (
                    <button
                      className="secondary-button"
                      onClick={() => onPitchReview(analysis.uncertaintyIntervals?.[0]?.startSeconds ?? 0)}
                    >
                      校对原曲主唱音高 <ArrowSquareOut size={15} />
                    </button>
                  )}
                  {rawUrl && <button className="secondary-button" disabled={busy} onClick={() => void getRaw(true)}>
                    打开原始模型副本 <ArrowSquareOut size={15} />
                  </button>}
                  <button className="secondary-button" onClick={() => void getEvidence()}>
                    模型分歧证据 <ArrowDown size={15} />
                  </button>
                </div>
              )}
            </>
          )}
          {pages.length > 0 && (
            <>
              <label className="field-label">
                对照页
                <select value={page} onChange={(event) => setPage(Number(event.target.value))}>
                  {pages.map((_, index) => (
                    <option key={index} value={index}>
                      原谱第 {index + 1} 页
                    </option>
                  ))}
                </select>
              </label>
              {pageUrl && (
                <a href={pageUrl} target="_blank" rel="noreferrer" aria-label="在新标签页放大原谱">
                  <img
                    className="source-page-preview"
                    src={pageUrl}
                    alt={`原始谱页 ${page + 1}，用于核对识别结果`}
                  />
                </a>
              )}
              <p>原谱只用于对照；修正乐谱请使用音符编辑器，不会改变这张图片。</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
