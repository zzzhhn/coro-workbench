import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import abcjs from 'abcjs';
import type { TuneObject } from 'abcjs';
import type { ScoreProject } from '../lib/types';
import type { Selection } from '../lib/editor';
import { beatsPerBar, toAbc } from '../lib/music';
import { alignEngravingArpeggios, alignEngravingStaffNames, fitEngravingSystems, prepareEngravingTune } from '../lib/engraving';
import type { MeasureRange } from '../lib/scoreWindow';
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
  measureRange?: MeasureRange;
  onSelect: (selection: Selection, beat?: number, extend?: boolean) => void;
  /** Note ids (part\0note) inside the active range, highlighted as a block. */
  rangeKeys?: Set<string>;
  /** Rubber-band selection: glyphs whose boxes intersect the dragged rectangle. */
  onRubberBand?: (hits: Array<{ partId: string; start: number }>) => void;
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
  measureRange,
  onSelect,
  rangeKeys,
  onRubberBand,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const tune = useRef<TuneObject | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // abcjs' click callback does not expose modifier keys; track Shift ourselves.
  const shiftDown = useRef(false);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number }>();
  const bandStart = useRef<{ x: number; y: number; active: boolean }>(undefined);
  const [error, setError] = useState('');
  const [renderVersion, setRenderVersion] = useState(0);
  const lastScrolledSystem = useRef(-1);
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
  const firstMeasure = measureRange?.start;
  const lastMeasure = measureRange?.end;
  const renderData = useMemo(() => {
    try {
      return {
        result: toAbc(
          notationProject,
          visiblePartIds?.filter((id) => project.parts.some((part) => part.id === id)),
          { barsPerSystem: mobile ? 2 : 4, staffSep: 37, systemSep: 34, measureRange },
        ),
        error: '',
      };
    } catch (cause) {
      return { result: undefined, error: cause instanceof Error ? cause.message : '乐谱数据无效。' };
    }
  }, [signature, visibleSignature, mobile, firstMeasure, lastMeasure]);
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
    container.current?.closest<HTMLElement>('.score-scroll')?.scrollTo({ top: 0 });
  }, [project.id, firstMeasure]);

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
        clickListener: (element, _tune, _classes, _analysis, _drag, mouseEvent?: MouseEvent) => {
          if (element.startChar === undefined) return;
          const mapped = abcResult.noteMap[element.startChar];
          const extend = Boolean(mouseEvent?.shiftKey ?? shiftDown.current);
          if (mapped) onSelectRef.current(mapped, abcResult.noteSegments?.[element.startChar]?.start, extend);
        },
        ariaLabel: `${project.title}，可交互五线谱。点击音符编辑，键盘上下键改变音高。`,
      });
      tune.current = rendered[0] ?? null;
      const systems = [...container.current.querySelectorAll<SVGSVGElement>('svg')];
      // abcjs places multi-voice staff names above their staff; recentre on the staff itself.
      alignEngravingStaffNames(systems);
      alignEngravingArpeggios(systems);
      const boxes = fitEngravingSystems(systems);
      setEngravedWidth(Math.ceil(Math.max(0, ...boxes.map((box) => box.width))));
      for (const [index, svg] of [...container.current.querySelectorAll('svg')].entries()) {
        svg.setAttribute(
          'aria-label',
          `${project.title}，第 ${abcResult.systemMeasures?.[index] ?? (firstMeasure ?? 1) + index * (mobile ? 2 : 4)} 小节起`,
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
      // A new part/layout changes scroll coordinates even at the same beat.
      lastScrolledSystem.current = -1;
      setRenderVersion((value) => value + 1);
    } catch (cause) {
      if (import.meta.env.DEV) console.error('Score engraving failed', cause);
      setError(cause instanceof Error ? cause.message : '乐谱渲染失败，请检查音符数据。');
    }
    return () => {
      tune.current = null;
    };
  }, [abcResult, width, mobile, singlePart, firstMeasure]);

  useEffect(() => {
    const nodes = container.current?.querySelectorAll<SVGElement>('[data-note-id]');
    let selectedGlyph: SVGElement | undefined;
    nodes?.forEach((node) => {
      const selected =
        node.dataset.partId === selection?.partId &&
        (node.dataset.noteId === selection?.noteId ||
          Boolean(
            selection &&
            node.dataset.noteIds &&
            (JSON.parse(node.dataset.noteIds) as string[]).includes(selection.noteId),
          ));
      node.classList.toggle('selected-note', selected);
      if (selected && (!selectedGlyph || (beat >= Number(node.dataset.start) && beat < Number(node.dataset.end))))
        selectedGlyph = node;
    });
    // Keep keyboard selection visible on a low staff when it crosses into a new window.
    const scroll = container.current?.closest<HTMLElement>('.score-scroll');
    if (!scroll || !selectedGlyph || playing) return;
    const bounds = selectedGlyph.getBoundingClientRect();
    const area = scroll.getBoundingClientRect();
    if (bounds.top < area.top || bounds.bottom > area.bottom) {
      const offset = bounds.top < area.top ? bounds.top - area.top - 14 : bounds.bottom - area.bottom + 14;
      scroll.scrollTo({ top: scroll.scrollTop + offset, behavior: 'instant' });
    }
  }, [selection, renderVersion]);

  useEffect(() => {
    container.current?.querySelectorAll<SVGElement>('[data-note-id]').forEach((node) => {
      const ids: string[] = node.dataset.noteIds ? JSON.parse(node.dataset.noteIds) : [node.dataset.noteId];
      node.classList.toggle(
        'range-note',
        Boolean(rangeKeys?.size && ids.some((id) => rangeKeys.has(`${node.dataset.partId}\0${id}`))),
      );
    });
  }, [rangeKeys, renderVersion]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => (shiftDown.current = event.shiftKey);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', down);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', down);
    };
  }, []);

  // Rubber band: drag on empty paper (not on a note) to select whole bars of the staves crossed.
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    shiftDown.current = event.shiftKey;
    if (!onRubberBand || event.button !== 0 || (event.target as Element).closest('[data-note-id]')) return;
    const box = event.currentTarget.getBoundingClientRect();
    bandStart.current = { x: event.clientX - box.left, y: event.clientY - box.top, active: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = bandStart.current;
    if (!start) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    if (!start.active && Math.hypot(x - start.x, y - start.y) < 6) return;
    if (!start.active) event.currentTarget.setPointerCapture(event.pointerId);
    start.active = true;
    setBand({ x0: Math.min(start.x, x), y0: Math.min(start.y, y), x1: Math.max(start.x, x), y1: Math.max(start.y, y) });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = bandStart.current;
    bandStart.current = undefined;
    if (!start?.active || !band || !container.current) {
      setBand(undefined);
      return;
    }
    const origin = event.currentTarget.getBoundingClientRect();
    const hits: Array<{ partId: string; start: number }> = [];
    container.current.querySelectorAll<SVGElement>('[data-note-id]').forEach((node) => {
      const r = node.getBoundingClientRect();
      const left = r.left - origin.left;
      const top = r.top - origin.top;
      if (left < band.x1 && left + r.width > band.x0 && top < band.y1 && top + r.height > band.y0)
        hits.push({ partId: node.dataset.partId!, start: Number(node.dataset.start) });
    });
    setBand(undefined);
    onRubberBand?.(hits);
  };

  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live || !container.current) return;
      const systems = [...container.current.querySelectorAll<SVGSVGElement>('svg')];
      alignEngravingStaffNames(systems);
      alignEngravingArpeggios(systems);
      const boxes = fitEngravingSystems(systems);
      setEngravedWidth(Math.ceil(Math.max(0, ...boxes.map((box) => box.width))));
      lastScrolledSystem.current = -1;
      setRenderVersion((value) => value + 1);
    });
    return () => {
      live = false;
    };
  }, [abcResult]);

  useEffect(() => {
    const nodes = container.current?.querySelectorAll<SVGElement>('[data-note-id]');
    nodes?.forEach((node) => {
      const active =
        playing && beat >= Number(node.dataset.start) - 0.03 && beat < Number(node.dataset.end) - 0.025;
      node.classList.toggle('sounding-note', active);
    });
    const scroll = container.current?.closest<HTMLElement>('.score-scroll');
    const currentBar = Math.max(0, Math.min(project.measures - 1, Math.floor(beat / beatsPerBar(project))));
    const systemIndex = abcResult?.systemMeasures?.length
      ? abcResult.systemMeasures.reduce(
          (last, measure, index) => (measure <= currentBar + 1 ? index : last),
          0,
        )
      : Math.floor(currentBar / (mobile ? 2 : 4));
    const system = container.current?.querySelectorAll('svg')[systemIndex];
    if (scroll && system && lastScrolledSystem.current !== systemIndex) {
      const bounds = system.getBoundingClientRect();
      const area = scroll.getBoundingClientRect();
      const atStart = beat < 0.05;
      if (atStart && !selection) scroll.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      else if (bounds.bottom < area.top + 20 || bounds.top > area.bottom - 100) {
        scroll.scrollTo({
          top: scroll.scrollTop + bounds.top - area.top - 20,
          behavior:
            playing && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant',
        });
      }
      lastScrolledSystem.current = systemIndex;
    }
  }, [beat, playing, renderVersion, project.id, mobile, abcResult]);

  const measure = Math.min(project.measures, Math.floor(beat / beatsPerBar(project)) + 1);
  // Dense systems can exceed the requested staff width on any screen. Pan the
  // score instead of shrinking every staff to the widest system's ratio.
  const minimumWidth = Math.max(mobile ? (singlePart ? 330 : 465) : 690, engravedWidth + (mobile ? 36 : 60));
  return (
    <div
      className={`score-paper ${showConfidence ? 'show-confidence' : ''} ${readingMode ? 'reading-score' : ''}`}
      style={{
        width: `${zoom}%`,
        minWidth: `${Math.max(minimumWidth, (minimumWidth * zoom) / 100)}px`,
      }}
    >
      <div className="paper-heading">
        <h2>{project.title}</h2>
        {project.composer && <p>{project.composer}</p>}
      </div>
      {abcResult?.warnings?.length ? (
        <details className="engraving-notice">
          <summary>谱表布局说明（{abcResult.warnings.length}）</summary>
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
      <div
        className="notation-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          bandStart.current = undefined;
          setBand(undefined);
        }}
      >
        <div className="notation" ref={container} data-testid="score" />
        {band && (
          <div
            className="rubber-band"
            data-testid="rubber-band"
            style={{ left: band.x0, top: band.y0, width: band.x1 - band.x0, height: band.y1 - band.y0 }}
          />
        )}
      </div>
      <div className="paper-foot">
        <span>
          {project.arrangement
            ? '合唱采样用于音高排练，非真人演唱。'
            : project.source.kind === 'demo'
              ? '原创合成示例 · 非音频识别结果'
              : '自动转谱请先校对，再交给歌者。'}
        </span>
      </div>
      <div className="sr-only" aria-live="off">
        当前第 {measure} 小节
      </div>
    </div>
  );
}
