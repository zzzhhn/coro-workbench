import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowSquareOut, CaretLeft, CaretRight, CornersOut, X } from '@phosphor-icons/react';
import type { ScoreProject } from '../lib/types';
import { resolveLocalAsset } from '../lib/projectBundle';
import { omrReviewOf } from '../lib/omrReview';
import {
  cropWindow,
  hitTest,
  omrMeasureOf,
  pageSize,
  regionFor,
  scoreMeasureOf,
  systemBox,
} from '../lib/sourceMap';
import { reviewKindLabels, type ReviewIssue, type ReviewKind } from '../lib/noteInput';

interface Props {
  project: ScoreProject;
  /** Measure (1-based) and part index currently focused in the score. */
  measure: number;
  partIndex?: number;
  noteId?: string;
  issues: ReviewIssue[];
  filter?: ReviewKind;
  onFilter: (kind?: ReviewKind) => void;
  currentIssue?: ReviewIssue;
  onIssue: (issue: ReviewIssue) => void;
  onClose: () => void;
  /** Jump the score to a measure (and optionally select a note) from the source image. */
  onJump: (target: { measure: number; partId?: string; noteId?: string }) => void;
  onMessage: (text: string, error?: boolean) => void;
}

export default function SourceRegionPanel({
  project,
  measure,
  partIndex,
  noteId,
  issues,
  filter,
  onFilter,
  currentIssue,
  onIssue,
  onClose,
  onJump,
  onMessage,
}: Props) {
  const review = omrReviewOf(project);
  const pages = project.source.pages ?? [];
  // `measure` is Coro's bar; the review uses the engine's measure numbers.
  const omrMeasure = omrMeasureOf(project, partIndex ?? 0, measure);
  const region = regionFor(project, omrMeasure, partIndex, noteId);
  const [page, setPage] = useState(region?.page ?? 0);
  const [whole, setWhole] = useState(!region);
  const [url, setUrl] = useState<string>();
  const frame = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(380);
  const counts = useMemo(() => {
    const value: Partial<Record<ReviewKind, number>> = {};
    for (const issue of issues) value[issue.kind] = (value[issue.kind] ?? 0) + 1;
    return value;
  }, [issues]);
  const shown = filter ? issues.filter((issue) => issue.kind === filter) : issues;

  // Follow the score: a measure on another page turns the page and zooms in.
  useEffect(() => {
    if (region) {
      setPage(region.page);
      setWhole(false);
    }
  }, [region?.page, region?.measure, region?.partIndex]);
  useEffect(() => {
    let live = true;
    const selected = pages[page];
    setUrl(undefined);
    if (!selected) return;
    void resolveLocalAsset(selected)
      .then((value) => live && setUrl(value))
      .catch((error) => onMessage(error instanceof Error ? error.message : '原谱页无法读取', true));
    return () => {
      live = false;
    };
  }, [pages[page], page]);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) =>
      setFrameWidth(Math.max(120, entries[0].contentRect.width)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const size = pageSize(project, page);
  const zoomed = Boolean(size && region && !whole && region.page === page);
  // Known part: centre on its band with a neighbouring staff of context; otherwise the whole system column.
  const partFocus = zoomed && partIndex !== undefined && region!.partIndex === partIndex;
  const focusBox =
    zoomed && review
      ? partFocus
        ? region!.box
        : (systemBox(review, page, omrMeasure) ?? region!.box)
      : undefined;
  const view = size
    ? focusBox
      ? cropWindow(size, focusBox, partFocus ? 0.45 : 0.12)
      : ([0, 0, size.width, size.height] as const)
    : undefined;
  const scale = view ? frameWidth / (view[2] - view[0]) : 1;
  const height = view ? (view[3] - view[1]) * scale : undefined;
  const place = (box: readonly number[]) =>
    view && {
      left: (box[0] - view[0]) * scale,
      top: (box[1] - view[1]) * scale,
      width: (box[2] - box[0]) * scale,
      height: (box[3] - box[1]) * scale,
    };
  const flagged = new Set(
    shown.filter((issue) => issue.severity === 'check' || filter).map((issue) => `${issue.measure}`),
  );
  const pageBoxes = review?.measures.filter((item) => item.page === page) ?? [];
  const columns = [...new Set(pageBoxes.map((item) => item.measure))].flatMap((value) => {
    const box = review && systemBox(review, page, value);
    return box ? [{ omr: value, measure: scoreMeasureOf(project, partIndex ?? 0, value), box }] : [];
  });

  const clickImage = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!view) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = view[0] + (event.clientX - bounds.left) / scale;
    const y = view[1] + (event.clientY - bounds.top) / scale;
    const hit = hitTest(project, page, x, y);
    if (!hit) {
      onMessage('这里没有对应的小节区域（标题、页边或未识别的谱表）。');
      return;
    }
    onJump({
      measure: scoreMeasureOf(project, hit.partIndex, hit.measure),
      partId: project.parts[hit.partIndex]?.id,
      noteId: hit.noteId,
    });
  };
  const describe = (issue: ReviewIssue) =>
    `${issue.partId ? `${project.parts.find((part) => part.id === issue.partId)?.shortName ?? ''} · ` : ''}${issue.message}`;

  return (
    <aside className="source-region-panel" aria-label="原谱对照">
      <header>
        <div>
          <strong>原谱对照</strong>
          <span>
            第 {measure} 小节
            {region
              ? ` · 原谱第 ${region.page + 1} 页`
              : review
                ? ' · 该小节无坐标，显示整页'
                : ' · 无识谱坐标，显示整页'}
          </span>
        </div>
        <button className="icon-button" aria-label="关闭原谱对照" title="关闭 (O)" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="source-region-tools">
        <button
          className="icon-button"
          aria-label="上一页原谱"
          disabled={page <= 0}
          onClick={() => {
            setPage(page - 1);
            setWhole(true);
          }}
        >
          <CaretLeft size={14} />
        </button>
        <span>{pages.length ? `${page + 1} / ${pages.length} 页` : '无原谱页'}</span>
        <button
          className="icon-button"
          aria-label="下一页原谱"
          disabled={page >= pages.length - 1}
          onClick={() => {
            setPage(page + 1);
            setWhole(true);
          }}
        >
          <CaretRight size={14} />
        </button>
        <button
          className={`text-tool ${zoomed ? 'active-tool' : ''}`}
          aria-pressed={zoomed}
          disabled={!region}
          onClick={() => {
            if (region) setPage(region.page);
            setWhole((value) => !value);
          }}
          title="在当前小节局部与整页之间切换"
        >
          <CornersOut size={14} /> {zoomed ? '局部' : '整页'}
        </button>
        {url && (
          <a
            className="icon-button"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="新标签页打开原谱"
          >
            <ArrowSquareOut size={14} />
          </a>
        )}
      </div>
      <div className="source-region-frame" ref={frame}>
        {url && view && size ? (
          <div
            className="source-region-viewport"
            data-testid="source-region-viewport"
            style={{ height }}
            onClick={clickImage}
            title="点击原谱中的小节或音符，跳回谱面"
          >
            <img
              src={url}
              alt={`原谱第 ${page + 1} 页${zoomed ? `，第 ${measure} 小节附近` : ''}`}
              draggable={false}
              style={{
                width: size.width * scale,
                height: size.height * scale,
                transform: `translate(${-view[0] * scale}px, ${-view[1] * scale}px)`,
              }}
            />
            {columns.map((item) => (
              <span
                key={item.omr}
                className={`source-box ${item.omr === omrMeasure ? 'current' : ''} ${flagged.has(`${item.measure}`) ? 'flagged' : ''}`}
                data-measure={item.measure}
                style={place(item.box)}
              >
                <i>{item.measure}</i>
              </span>
            ))}
            {region && region.page === page && (
              <span
                className={`source-box part-band ${region.estimated ? 'estimated' : ''}`}
                data-testid="source-part-band"
                style={place(region.box)}
              />
            )}
            {region?.point && region.page === page && (
              <span
                className="source-anchor"
                data-testid="source-anchor"
                title="近似位置"
                style={{
                  left: (region.point[0] - view[0]) * scale,
                  top: (region.point[1] - view[1]) * scale,
                }}
              />
            )}
          </div>
        ) : url ? (
          <img className="source-region-plain" src={url} alt={`原谱第 ${page + 1} 页`} />
        ) : (
          <p className="subtle-note">
            {pages.length ? '正在读取原谱页…' : '这份乐谱不是从图片或 PDF 识谱导入的。'}
          </p>
        )}
      </div>
      {review && (
        <p className="source-approximate">
          框和点是识谱给出的<strong>近似位置</strong>
          {region?.estimated ? '；本小节边界为估计，未对齐到小节线' : ''}，请以原谱为准。
        </p>
      )}
      <section className="source-issues" aria-label="可疑项">
        <div className="source-issue-filters" role="group" aria-label="按原因筛选">
          <button aria-pressed={!filter} onClick={() => onFilter(undefined)}>
            全部 <b>{issues.filter((issue) => issue.severity === 'check').length}</b>
          </button>
          {(Object.keys(reviewKindLabels) as ReviewKind[])
            .filter((kind) => counts[kind])
            .map((kind) => (
              <button key={kind} aria-pressed={filter === kind} onClick={() => onFilter(kind)}>
                {reviewKindLabels[kind]} <b>{counts[kind]}</b>
              </button>
            ))}
        </div>
        <ol>
          {shown.slice(0, 300).map((issue, index) => (
            <li key={`${issue.kind}-${issue.measure}-${issue.partId ?? ''}-${issue.noteId ?? index}`}>
              <button
                className={`${issue.severity} ${
                  currentIssue &&
                  currentIssue.kind === issue.kind &&
                  currentIssue.measure === issue.measure &&
                  currentIssue.noteId === issue.noteId &&
                  currentIssue.message === issue.message
                    ? 'current'
                    : ''
                }`}
                onClick={() => onIssue(issue)}
                title={issue.evidence}
              >
                <span>第 {issue.measure} 小节</span>
                <em>{reviewKindLabels[issue.kind]}</em>
                <small>{describe(issue)}</small>
              </button>
            </li>
          ))}
          {!shown.length && <li className="subtle-note">没有此类可疑项；仍需逐小节对照原谱。</li>}
        </ol>
        <p className="subtle-note">[ ] 按当前筛选逐项跳转；“全部”跳过仅供参考的条目（如已贴附的文字）。</p>
      </section>
    </aside>
  );
}
