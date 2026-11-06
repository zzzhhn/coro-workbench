import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import abcjs from 'abcjs';
import type { TuneObject } from 'abcjs';
import type { ScoreProject } from '../lib/types';
import type { Selection } from '../lib/editor';
import { beatsPerBar, toAbc } from '../lib/music';
import { fitEngravingSystems, prepareEngravingTune } from '../lib/engraving';
import { overlapsUncertainSource } from './workspaceView';

interface Props {
  project: ScoreProject;
  visiblePartIds?: string[];
  selection?: Selection;
  beat: number;
  playing: boolean;
  zoom: number;
  showConfidence: boolean;
  readingMode?: boolean;
  onSelect: (selection: Selection) => void;
}

export default function ScoreView({
  project,
  visiblePartIds,
  selection,
  beat,
  playing,
  zoom,
  showConfidence,
  readingMode = false,
  onSelect,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const tune = useRef<TuneObject | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [error, setError] = useState('');
  const [renderVersion, setRenderVersion] = useState(0);
  const lastScrolledBar = useRef(-1);
  const [width, setWidth] = useState(1000);
  const [engravedWidth, setEngravedWidth] = useState(0);
  const mobile = typeof window !== 'undefined' && window.innerWidth < 760;
  const singlePart = visiblePartIds?.length === 1;
  const notationProject = useMemo(
    () => ({
      ...project,
      title: '',
      composer: '',
      updatedAt: '',
      originalAudio: undefined,
      parts: project.parts.map((part) => ({
        ...part,
        name: mobile ? part.shortName : part.name.split(' · ')[0],
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
      })),
    }),
    [project, mobile],
  );
  // Mixing is independent of engraving; moving a fader must not rebuild the score.
  const signature = useMemo(() => JSON.stringify(notationProject), [notationProject]);
  const visibleSignature = visiblePartIds?.join('|');
  const renderData = useMemo(() => {
    try {
      return {
        result: toAbc(
          notationProject,
          visiblePartIds?.filter((id) => project.parts.some((part) => part.id === id)),
          { barsPerSystem: mobile ? 2 : 4, staffSep: 37, systemSep: 34 },
        ),
        error: '',
      };
    } catch (cause) {
      return { result: undefined, error: cause instanceof Error ? cause.message : '乐谱数据无效。' };
    }
  }, [signature, visibleSignature, mobile]);
  const abcResult = renderData.result;
  const noteLookup = useMemo(
    () =>
      new Map(
        project.parts.flatMap((part) =>
          part.notes.map((note) => [`${part.id}\0${note.id}`, { note, part }] as const),
        ),
      ),
    [project],
  );

  useLayoutEffect(() => {
    const wrapper = container.current?.parentElement;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const value = Math.floor(entries[0].contentRect.width);
      setWidth((previous) => (Math.abs(previous - value) > 5 ? value : previous));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!container.current || !abcResult) return;
    try {
      setError('');
      const rendered = abcjs.renderAbc(container.current, abcResult.abc, {
        add_classes: true,
        responsive: 'resize',
        staffwidth: mobile ? (singlePart ? 300 : 425) : Math.max(650, Math.min(1120, width - 48)),
        paddingtop: 0,
        paddingbottom: 30,
        paddingleft: 10,
        paddingright: 16,
        scale: 1,
        oneSvgPerLine: true,
        afterParsing: (tune) => prepareEngravingTune(tune, abcResult),
        selectionColor:
          getComputedStyle(container.current).getPropertyValue('--score-selection').trim() || '#b45a39',
        selectTypes: ['note'],
        format: {
          titlefont: 'Newsreader 27',
          composerfont: 'DM Sans 11',
          voicefont: 'DM Sans 11',
          gchordfont: 'DM Sans 12',
          vocalfont: 'DM Sans 12',
          measurefont: 'DM Mono 9',
        },
        clickListener: (element) => {
          if (element.startChar === undefined) return;
          const mapped = abcResult.noteMap[element.startChar];
          if (mapped) onSelectRef.current(mapped);
        },
        ariaLabel: `${project.title}，可交互五线谱。点击音符编辑，键盘上下键改变音高。`,
      });
      tune.current = rendered[0] ?? null;
      const boxes = fitEngravingSystems([...container.current.querySelectorAll<SVGSVGElement>('svg')]);
      setEngravedWidth(Math.ceil(Math.max(0, ...boxes.map((box) => box.width))));
      for (const [index, svg] of [...container.current.querySelectorAll('svg')].entries()) {
        svg.setAttribute(
          'aria-label',
          `${project.title}，第 ${abcResult.systemMeasures?.[index] ?? index * (mobile ? 2 : 4) + 1} 小节起`,
        );
      }
      const selectables = tune.current?.getSelectableArray() ?? [];
      for (const item of selectables) {
        const character = item.absEl?.abcelem?.startChar;
        const mapped = character === undefined ? undefined : abcResult.noteMap[character];
        if (!mapped || !item.svgEl) continue;
        item.svgEl.dataset.noteId = mapped.noteId;
        item.svgEl.dataset.partId = mapped.partId;
        const found = noteLookup.get(`${mapped.partId}\0${mapped.noteId}`);
        const segment = character === undefined ? undefined : abcResult.noteSegments?.[character];
        if (found) {
          item.svgEl.dataset.start = String(segment?.start ?? found.note.start);
          item.svgEl.dataset.end = String(
            segment ? segment.start + segment.duration : found.note.start + found.note.duration,
          );
          if (segment) {
            item.svgEl.dataset.noteIds = JSON.stringify(segment.noteIds);
            item.svgEl.dataset.exactSegment = 'true';
          }
          if (found.note.confidence !== undefined && found.note.confidence < 0.6)
            item.svgEl.classList.add('low-confidence');
          if (
            overlapsUncertainSource(
              project,
              mapped.partId,
              segment?.start ?? found.note.start,
              segment?.duration ?? found.note.duration,
            )
          ) {
            item.svgEl.classList.add('uncertain-note');
            item.svgEl.dataset.uncertain = 'true';
          }
          item.svgEl.style.setProperty('--part-color', found.part.color);
          item.svgEl.setAttribute('data-testid', 'score-note');
        }
      }
      const occurrences = new Map<string, SVGElement[]>();
      for (const node of container.current.querySelectorAll<SVGElement>('[data-note-id]')) {
        const key = `${node.dataset.partId}\0${node.dataset.noteId}`;
        const elements = occurrences.get(key) ?? [];
        elements.push(node);
        occurrences.set(key, elements);
      }
      // One event can be engraved as tied glyphs. Light only the time span of
      // each glyph, not all systems containing the underlying held note.
      for (const elements of occurrences.values()) {
        if (elements.length < 2 || elements.every((node) => node.dataset.exactSegment === 'true')) continue;
        const originalStart = Number(elements[0].dataset.start);
        let cursor = originalStart;
        for (const node of elements) {
          const selected = selectables.find((item) => item.svgEl === node);
          const element = selected?.absEl;
          const raw = (element?.durationClass ?? element?.duration ?? 0) * 4;
          const triplet = element?.abcelem.tripletMultiplier ?? 1;
          const end = Math.min(Number(node.dataset.end), cursor + raw * triplet);
          if (end > cursor) {
            node.dataset.start = String(cursor);
            node.dataset.end = String(end);
            cursor = end;
          }
        }
      }
      setRenderVersion((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '乐谱渲染失败，请检查音符数据。');
    }
    return () => {
      tune.current = null;
    };
  }, [abcResult, width, mobile, singlePart]);

  useEffect(() => {
    const nodes = container.current?.querySelectorAll<SVGElement>('[data-note-id]');
    nodes?.forEach((node) => {
      node.classList.toggle(
        'selected-note',
        node.dataset.partId === selection?.partId &&
          (node.dataset.noteId === selection?.noteId ||
            Boolean(
              selection &&
              node.dataset.noteIds &&
              (JSON.parse(node.dataset.noteIds) as string[]).includes(selection.noteId),
            )),
      );
    });
  }, [selection, renderVersion]);

  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live || !container.current) return;
      const boxes = fitEngravingSystems([...container.current.querySelectorAll<SVGSVGElement>('svg')]);
      setEngravedWidth(Math.ceil(Math.max(0, ...boxes.map((box) => box.width))));
      setRenderVersion((value) => value + 1);
    });
    return () => {
      live = false;
    };
  }, [abcResult]);

  useEffect(() => {
    const nodes = container.current?.querySelectorAll<SVGElement>('[data-note-id]');
    let first: SVGElement | undefined;
    nodes?.forEach((node) => {
      const active =
        playing && beat >= Number(node.dataset.start) - 0.03 && beat < Number(node.dataset.end) - 0.025;
      node.classList.toggle('sounding-note', active);
      if (active && !first) first = node;
    });
    const scroll = container.current?.closest<HTMLElement>('.score-scroll');
    const currentBar = Math.floor(beat / beatsPerBar(project));
    const systemIndex = abcResult?.systemMeasures?.length
      ? abcResult.systemMeasures.reduce(
          (last, measure, index) => (measure <= currentBar + 1 ? index : last),
          0,
        )
      : Math.floor(currentBar / (mobile ? 2 : 4));
    const system = container.current?.querySelectorAll('svg')[systemIndex];
    if (scroll && system && lastScrolledBar.current !== currentBar) {
      const bounds = system.getBoundingClientRect();
      const area = scroll.getBoundingClientRect();
      const atStart = beat < 0.05;
      if (atStart) scroll.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      else if (bounds.top < area.top - 35 || bounds.top > area.bottom - 100) {
        scroll.scrollTo({
          top: scroll.scrollTop + bounds.top - area.top - 20,
          behavior:
            playing && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant',
        });
      }
      lastScrolledBar.current = currentBar;
    }
  }, [beat, playing, renderVersion, project.id, mobile, abcResult]);

  useEffect(() => {
    lastScrolledBar.current = -1;
    container.current?.closest<HTMLElement>('.score-scroll')?.scrollTo({ top: 0, left: 0 });
  }, [project.id]);

  const measure = Math.min(project.measures, Math.floor(beat / beatsPerBar(project)) + 1);
  // Dense systems can be wider than the requested staff width. On phones, pan
  // the score instead of shrinking every staff to the widest system's ratio.
  const minimumWidth = mobile ? Math.max(singlePart ? 330 : 465, engravedWidth + 36) : 690;
  return (
    <div
      className={`score-paper ${showConfidence ? 'show-confidence' : ''} ${readingMode ? 'reading-score' : ''}`}
      style={{
        width: `${zoom}%`,
        minWidth: `${Math.max(minimumWidth, (minimumWidth * zoom) / 100)}px`,
      }}
    >
      <div className="paper-kicker">
        <span>{singlePart ? '分声部谱' : '完整总谱'}</span>
        <span>
          {project.arrangement ? project.arrangement.options.preset.toUpperCase() : '原曲'} /{' '}
          {project.measures} 小节
        </span>
      </div>
      <div className="paper-heading">
        <h2>{project.title}</h2>
        <p>{project.composer}</p>
      </div>
      {abcResult?.warnings?.length ? (
        <details className="engraving-notice">
          <summary>已自动整理谱表与复音布局 · 原音符保留（{abcResult.warnings.length} 项说明）</summary>
          <ul>
            {abcResult.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {error || renderData.error ? (
        <div role="alert" className="score-error">
          {error || renderData.error}
        </div>
      ) : null}
      <div className="notation" ref={container} data-testid="score" />
      <div className="paper-foot">
        <span>
          {project.arrangement
            ? '合唱采样用于音高排练，非真人演唱。'
            : project.source.kind === 'demo'
              ? '原创合成示例 · 非音频识别结果'
              : '自动转谱请先校对，再交给歌者。'}
        </span>
        <span>Coro · {project.measures} bars</span>
      </div>
      <div className="sr-only" aria-live="off">
        当前第 {measure} 小节
      </div>
    </div>
  );
}
