import { useEffect, useState } from 'react';
import { ArrowDown, ArrowSquareOut, CaretDown, FileText, Info } from '@phosphor-icons/react';
import type { ScoreProject } from '../lib/types';
import { downloadFile, parseProject } from '../lib/storage';
import { resolveLocalAsset } from '../lib/projectBundle';
import { Headphones } from '@phosphor-icons/react';
import { pitchVerificationSummary } from '../lib/verificationSummary';

export default function SourceEvidence({
  project,
  onImportCopy,
  onMessage,
  onSeek,
  onAudio,
  onPitchReview,
}: {
  project: ScoreProject;
  onImportCopy: (project: ScoreProject) => void;
  onMessage: (message: string, error?: boolean) => void;
  onSeek?: (seconds: number) => void;
  onAudio?: (url: string, name: string) => void;
  onPitchReview?: (seconds: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [pageUrl, setPageUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const analysis = project.source.analysis;
  const verification = pitchVerificationSummary(analysis);
  const pages = project.source.pages ?? [];
  const rawUrl = analysis?.rawProjectUrl;
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
  if (!analysis && !pages.length) return null;
  const getRaw = async (open: boolean) => {
    if (!rawUrl || !/^\/api\/projects\/[a-f0-9]{32}\/raw$/.test(rawUrl)) return;
    setBusy(true);
    try {
      const response = await fetch(rawUrl);
      if (!response.ok) throw new Error('原始转写未找到，请检查原任务是否仍在本机。');
      const text = await response.text();
      if (open) {
        const raw = parseProject(text);
        raw.id = crypto.randomUUID();
        raw.title += ' · 原始模型副本';
        onImportCopy(raw);
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
    if (!rawUrl || !/^\/api\/projects\/[a-f0-9]{32}\/raw$/.test(rawUrl)) return;
    try {
      const response = await fetch(rawUrl.replace(/\/raw$/, '/evidence'));
      if (!response.ok) throw new Error('模型证据在本机尚不可用。');
      downloadFile(await response.blob(), 'model-disagreements.json', 'application/json');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '读取模型证据失败', true);
    }
  };
  return (
    <section className={`source-evidence ${expanded ? 'expanded' : ''}`}>
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
            ? `${analysis.rhythm.bpm.toFixed(1)} BPM · ${analysis.transforms.length} 项处理，${rawUrl ? '原始结果保留' : '提案来源记录'}`
            : project.source.engine}
        </span>
        {rawUrl && (
          <button className="text-button" disabled={busy} onClick={() => void getRaw(false)}>
            <ArrowDown size={14} />
            原始转写
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
            </div>
          )}
          {verification && (
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
              <strong>这些段落仍有主唱 / 八度分歧</strong>
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
                  : '此工程保留处理说明；原始模型结果与详细模型证据需在原工作台另行保存，不在此便携工程中。'}
              </p>
              <ul>
                {analysis.transforms.map((transform, index) => (
                  <li key={index}>{transform}</li>
                ))}
              </ul>
              {analysis.rhythm && (
                <p>
                  节拍来源：{analysis.rhythm.method}；第 1 拍相对原音频{' '}
                  {analysis.rhythm.offsetSeconds.toFixed(3)} 秒。节拍置信度并非转谱准确率。
                </p>
              )}
              {rawUrl && (
                <div className="note-actions">
                  {onPitchReview && project.source.kind === 'audio' && (
                    <button
                      className="secondary-button"
                      onClick={() => onPitchReview(analysis.uncertaintyIntervals?.[0]?.startSeconds ?? 0)}
                    >
                      校对原曲主唱音高 <ArrowSquareOut size={15} />
                    </button>
                  )}
                  <button className="secondary-button" disabled={busy} onClick={() => void getRaw(true)}>
                    打开原始模型副本 <ArrowSquareOut size={15} />
                  </button>
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
