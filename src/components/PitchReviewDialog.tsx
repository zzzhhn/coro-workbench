import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Pause, Play, Scissors, WarningCircle } from '@phosphor-icons/react';
import Modal from './Modal';
import { PlaybackEngine, type PlaybackState } from '../lib/audio';
import { pitchName } from '../lib/music';
import { deleteNote } from '../lib/editor';
import { resolveLocalAsset } from '../lib/projectBundle';
import {
  changedReviewNotes,
  editNoteFromSourceTime,
  insertNoteFromSourceTime,
  getPitchEvidence,
  getPitchCoverage,
  coverageWindowStart,
  pitchCoverageLabels,
  pitchEvidenceJobId,
  pitchBranchUrl,
  pitchReviewAudioUrl,
  sourceBeat,
  sourceSecond,
  sourceWindowNotes,
  splitNoteAtSourceTime,
  type PitchEvidence,
  type PitchCoverage,
} from '../lib/pitchReview';
import type { ScoreProject } from '../lib/types';
import { downloadFile, serializeProject } from '../lib/storage';
import {
  changeReview,
  checkpointKey,
  deleteReviewDraft,
  newReviewDraft,
  readReviewDraft,
  reviewMatchesProject,
  reviewProject,
  reviewStatusLabels,
  saveReviewDraft,
  stepReview,
  type ReviewDraft,
  type ReviewStatus,
} from '../lib/reviewDraft';

const WIDTH = 960,
  HEIGHT = 330,
  LEFT = 62,
  RIGHT = 20,
  TOP = 30,
  BOTTOM = 28;
type ListeningMode = 'notes' | 'original' | 'lead' | 'backing';

export default function PitchReviewDialog({
  project,
  initialSeconds,
  hasArrangement,
  onApply,
  onClose,
}: {
  project: ScoreProject;
  initialSeconds: number;
  hasArrangement: boolean;
  onApply: (draft: ScoreProject) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(project));
  const record = useRef<ReviewDraft | undefined>(undefined);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  const [ready, setReady] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftStatus, setDraftStatus] = useState('正在读取校对草稿…');
  const [conflict, setConflict] = useState<ReviewDraft>();
  const [discarding, setDiscarding] = useState(false);
  const [applying, setApplying] = useState(false);
  const [duration, setDuration] = useState(project.originalAudio?.duration ?? 0);
  const [start, setStart] = useState(Math.max(0, Math.min(Math.max(0, duration - 8), initialSeconds - 2)));
  const [length, setLength] = useState(8);
  const [positionInput, setPositionInput] = useState(String(Math.max(0, initialSeconds - 2).toFixed(1)));
  const [cursor, setCursor] = useState(initialSeconds);
  const [cursorInput, setCursorInput] = useState(initialSeconds.toFixed(3));
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [pitchInput, setPitchInput] = useState('60');
  const [onsetInput, setOnsetInput] = useState('0');
  const [offsetInput, setOffsetInput] = useState('1');
  const [evidence, setEvidence] = useState<PitchEvidence>();
  const [coverage, setCoverage] = useState<PitchCoverage>();
  const [coverageError, setCoverageError] = useState('');
  const [coverageIndex, setCoverageIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<ListeningMode>(() =>
    pitchReviewAudioUrl(project) ? 'lead' : 'original',
  );
  const [audioBusy, setAudioBusy] = useState(false);
  const [playback, setPlayback] = useState<PlaybackState>({
    playing: false,
    beat: 0,
    peak: 0,
    mode: 'score',
  });
  const engine = useRef<PlaybackEngine | null>(null);
  const partId = 'vocals';
  const part = draft.parts.find((part) => part.id === partId);
  const jobId = pitchEvidenceJobId(project);
  const end = Math.min(duration, start + length);
  const notes = useMemo(() => sourceWindowNotes(draft, partId, start, end), [draft, start, end]);
  const note = part?.notes.find((note) => note.id === selected);
  const changed = useMemo(() => changedReviewNotes(project, draft, partId), [project, draft]);
  const quality = project.source.analysis?.quality;
  const leadUrl = pitchReviewAudioUrl(project);
  const backingUrl = pitchBranchUrl(quality?.backingAudioUrl);

  const persist = (next: ReviewDraft) => {
    record.current = next;
    const current = ++sequence.current;
    setDraftBusy(true);
    setDraftError('');
    setDraftStatus('正在保存草稿…');
    const saving = writes.current.catch(() => {}).then(() => saveReviewDraft(next));
    writes.current = saving;
    void saving.then(
      () => {
        if (sequence.current === current) {
          setDraftBusy(false);
          setDraftStatus('草稿已保存到本机');
        }
      },
      (cause) => {
        if (sequence.current === current) {
          setDraftBusy(false);
          setDraftError(`草稿未保存：${cause instanceof Error ? cause.message : cause}`);
        }
      },
    );
    return saving;
  };
  const restore = (next: ReviewDraft) => {
    record.current = next;
    setDraft(reviewProject(next, project));
    setStart(next.position.start);
    setLength(next.position.length);
    setCursor(next.position.cursor);
    setCursorInput(next.position.cursor.toFixed(3));
    setPositionInput(next.position.start.toFixed(1));
    setSelected(next.position.selected);
  };
  useEffect(() => {
    let active = true;
    void readReviewDraft(project.id)
      .then((saved) => {
        if (!active) return;
        if (saved && !reviewMatchesProject(saved, project)) {
          setConflict(saved);
          setDraftStatus('原谱已改变，旧草稿未自动套用');
        } else {
          restore(saved ?? newReviewDraft(project, initialSeconds));
          setDraftStatus(saved ? '已恢复上次校对草稿' : '修改后自动保存草稿');
        }
        setReady(true);
      })
      .catch((cause) => {
        if (active) setDraftError(`无法读取草稿：${cause instanceof Error ? cause.message : cause}`);
      });
    return () => {
      active = false;
    };
  }, [project.id]);
  useEffect(() => {
    if (!ready || conflict || !record.current) return;
    const position = { start, length, cursor, selected, coverageKey: record.current.position.coverageKey };
    if (JSON.stringify(position) === JSON.stringify(record.current.position)) return;
    void persist({ ...record.current, position, savedAt: new Date().toISOString() }).catch(() => {});
  }, [ready, start, length, cursor, selected, conflict]);
  useEffect(() => {
    const key = record.current?.position.coverageKey;
    if (coverage && key)
      setCoverageIndex(coverage.intervals.findIndex((interval) => checkpointKey(interval) === key));
  }, [coverage, ready]);
  useEffect(() => {
    if (!draftBusy && !draftError) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draftBusy, draftError]);
  const keepAndClose = async () => {
    if (applying) return;
    try {
      await writes.current;
      onClose();
    } catch {
      setDraftError('草稿尚未保存，请重试保存或导出草稿后再关闭。');
    }
  };
  const commitReview = async (next: ReviewDraft) => {
    engine.current?.pause();
    setDraft(reviewProject(next, project));
    try {
      await persist(next);
    } catch {
      /* The visible unsaved edit can be retried or exported. */
    }
  };
  const travel = (direction: 'undo' | 'redo') => {
    if (!record.current || draftBusy || conflict || applying) return;
    void commitReview(stepReview(record.current, direction));
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        !ready ||
        conflict ||
        target.isContentEditable ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        travel(event.shiftKey ? 'redo' : 'undo');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    setCoverageError('');
    void getPitchCoverage(jobId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCoverage(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setCoverageError(error instanceof Error ? error.message : '检查点读取失败。');
      });
    return () => controller.abort();
  }, [jobId]);
  useEffect(() => {
    const player = new PlaybackEngine();
    engine.current = player;
    player.subscribe(setPlayback);
    return () => {
      player.dispose();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    if (!jobId || end <= start) return;
    const controller = new AbortController();
    setLoading(true);
    setEvidence(undefined);
    setError('');
    void getPitchEvidence(jobId, start, end, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setEvidence(result);
          setDuration(
            Math.min(project.originalAudio?.duration ?? result.durationSeconds, result.durationSeconds),
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '音高校验读取失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [jobId, start, end]);
  useEffect(() => {
    if (!note || note.midi === null) return;
    setPitchInput(String(note.midi));
    setOnsetInput(sourceSecond(draft, note.start).toFixed(3));
    setOffsetInput(sourceSecond(draft, note.start + note.duration).toFixed(3));
  }, [note, draft]);

  const placeCursor = (seconds: number) => {
    setCursor(seconds);
    setCursorInput(seconds.toFixed(3));
  };
  const commitCursor = () => {
    if (cursorInput.trim() !== '' && Number.isFinite(Number(cursorInput))) {
      engine.current?.pause();
      placeCursor(Number(cursorInput));
    }
  };
  const moveWindow = (seconds: number) => {
    engine.current?.pause();
    const next = Math.max(0, Math.min(Math.max(0, duration - length), seconds));
    setStart(next);
    placeCursor(next);
    setPositionInput(next.toFixed(1));
    setSelected('');
    setAdding(false);
    setCoverageIndex(-1);
    if (record.current)
      record.current = {
        ...record.current,
        position: { ...record.current.position, coverageKey: undefined },
      };
  };
  const visitCoverage = (index: number) => {
    const interval = coverage?.intervals[index];
    if (!interval) return;
    moveWindow(coverageWindowStart(interval, length, duration));
    if (record.current)
      void persist({
        ...record.current,
        position: { ...record.current.position, coverageKey: checkpointKey(interval) },
      }).catch(() => {});
    setCoverageIndex(index);
  };
  const selectNote = (id: string, seconds: number) => {
    engine.current?.pause();
    setSelected(id);
    setAdding(false);
    placeCursor(seconds);
  };
  const updateDraft = (action: () => ScoreProject) => {
    if (!record.current || draftBusy || conflict || applying) return;
    engine.current?.pause();
    try {
      const next = action();
      void commitReview(
        changeReview(record.current, {
          ...record.current.snapshot,
          notes: next.parts.find((part) => part.id === partId)!.notes,
        }),
      );
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法修改音符。');
    }
  };
  const listen = async () => {
    if (playback.playing) {
      engine.current?.pause();
      return;
    }
    setAudioBusy(true);
    setError('');
    try {
      const url = mode === 'lead' ? leadUrl : mode === 'backing' ? backingUrl : project.originalAudio?.url;
      if (mode !== 'notes' && !url) throw new Error('所选音频不在这个工程中。');
      const playbackProject = {
        ...draft,
        parts: draft.parts.map((item) => ({ ...item, muted: item.id !== partId, solo: item.id === partId })),
      };
      await engine.current?.play(playbackProject, {
        mode: mode === 'notes' ? 'score' : 'source',
        startBeat: sourceBeat(draft, cursor >= start && cursor < end ? cursor : start),
        loop: true,
        loopStart: sourceBeat(draft, start),
        loopEnd: sourceBeat(draft, end),
        metronome: false,
        countIn: false,
        sourceUrl: mode === 'notes' ? undefined : await resolveLocalAsset(url!),
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : '试听失败。');
    } finally {
      setAudioBusy(false);
    }
  };
  const chart = useMemo(() => {
    const values = [
      ...notes.map(({ note }) => note.midi!),
      ...(evidence?.frames ?? []).flatMap((frame) =>
        [frame.fcpeMidi, frame.crepeMidi].filter((value): value is number => value !== null),
      ),
    ];
    const low = values.length ? Math.max(0, Math.floor(Math.min(...values)) - 2) : 48;
    const high = values.length ? Math.min(127, Math.ceil(Math.max(...values)) + 2) : 84;
    const x = (seconds: number) =>
      LEFT + ((seconds - start) / Math.max(0.001, end - start)) * (WIDTH - LEFT - RIGHT);
    const y = (pitch: number) => TOP + ((high - pitch) / Math.max(1, high - low)) * (HEIGHT - TOP - BOTTOM);
    const line = (field: 'fcpeMidi' | 'crepeMidi') => {
      let path = '',
        gap = true;
      for (const frame of evidence?.frames ?? []) {
        if (frame[field] === null) {
          gap = true;
          continue;
        }
        path += `${gap ? 'M' : 'L'}${x(frame.seconds).toFixed(2)},${y(frame[field]!).toFixed(2)} `;
        gap = false;
      }
      return path;
    };
    return { low, high, x, y, fcpe: line('fcpeMidi'), crepe: line('crepeMidi') };
  }, [evidence, notes, start, end]);
  const cursorSeconds = playback.playing ? sourceSecond(draft, playback.beat) : cursor;
  const outputPercent = Number((Math.max(0, Math.min(1, playback.peak)) * 100).toFixed(2));
  const framesForNote = note
    ? (evidence?.frames ?? []).filter(
        (frame) =>
          frame.seconds >= sourceSecond(draft, note.start) &&
          frame.seconds < sourceSecond(draft, note.start + note.duration),
      )
    : [];
  const modelMedian = (field: 'fcpeMidi' | 'crepeMidi') => {
    const values = framesForNote
      .map((frame) => frame[field])
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)].toFixed(2) : '无可靠发声帧';
  };

  return (
    <Modal title="主唱音高校对" eyebrow="PITCH REVIEW" wide onClose={() => void keepAndClose()}>
      <div className="pitch-review" inert={applying || undefined}>
        <div className="pitch-draft-toolbar">
          <span role="status">{draftStatus}</span>
          <button
            className="secondary-button"
            disabled={!ready || draftBusy || applying || Boolean(conflict) || !record.current?.past.length}
            onClick={() => travel('undo')}
          >
            撤销校对
          </button>
          <button
            className="secondary-button"
            disabled={!ready || draftBusy || applying || Boolean(conflict) || !record.current?.future.length}
            onClick={() => travel('redo')}
          >
            重做校对
          </button>
        </div>
        {draftError && (
          <div role="alert" className="error-message">
            {draftError}
            {record.current && (
              <>
                <button className="secondary-button" onClick={() => void commitReview(record.current!)}>
                  重试保存
                </button>
                <button
                  className="secondary-button"
                  onClick={() =>
                    downloadFile(
                      serializeProject(reviewProject(record.current!)),
                      `${project.title}-校对草稿.coro.json`,
                      'application/json',
                    )
                  }
                >
                  导出草稿
                </button>
              </>
            )}
          </div>
        )}
        {conflict && (
          <div role="alert" className="error-message">
            原谱在上次校对后已改变。旧草稿保留在本机，请先导出留存，或明确放弃旧草稿后开始本次校对。
            <button
              className="secondary-button"
              onClick={() =>
                downloadFile(
                  serializeProject(reviewProject(conflict)),
                  `${project.title}-旧校对草稿.coro.json`,
                  'application/json',
                )
              }
            >
              导出旧草稿
            </button>
            <button
              className="secondary-button"
              disabled={draftBusy}
              onClick={async () => {
                const next = newReviewDraft(project, initialSeconds);
                try {
                  await persist(next);
                  restore(next);
                  setConflict(undefined);
                } catch {
                  /* Keep conflict visible. */
                }
              }}
            >
              放弃旧草稿，按当前原谱开始
            </button>
          </div>
        )}
        <p className="modal-description">
        把原录音、当前人声轨、两条模型轨迹与当前音符放在同一时间轴上。
          只编辑原曲主唱，模型线不是正确答案；先试听，再把修改应用到乐谱。
        </p>
        {!ready || conflict ? null : !jobId || !part || !project.originalAudio ? (
          <p className="error-message">此工程没有可对照的原曲主唱与本机连续音高。便携包不含模型张量。</p>
        ) : (
          <>
            <div className="pitch-coverage">
              <div className="pitch-coverage-heading">
                <strong>待听检查点</strong>
                <span>
                  {coverage
                    ? `${coverage.totalIntervals} 处原始模型证据`
                    : coverageError
                      ? '不可用'
                      : '读取中…'}
                </span>
              </div>
              {coverage && coverage.intervals.length > 0 && (
                <div className="pitch-coverage-controls">
                  <button
                    className="secondary-button"
                    aria-label="上一个待听检查点"
                    disabled={coverageIndex <= 0}
                    onClick={() => visitCoverage(coverageIndex - 1)}
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <select
                    aria-label="待听检查点"
                    value={coverageIndex}
                    onChange={(event) => visitCoverage(Number(event.target.value))}
                  >
                    <option value={-1}>选择检查点，定位原音频试听</option>
                    {coverage.intervals.map((item, index) => (
                      <option key={`${item.kind}-${item.startSeconds}`} value={index}>
                        {index + 1}. {item.startSeconds.toFixed(2)}–{item.endSeconds.toFixed(2)}s ·{' '}
                        {pitchCoverageLabels[item.kind]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="secondary-button"
                    aria-label="下一个待听检查点"
                    disabled={coverageIndex >= coverage.intervals.length - 1}
                    onClick={() => visitCoverage(coverageIndex + 1)}
                  >
                    <ArrowRight size={16} />
                  </button>
                </div>
              )}
              {coverage && record.current && (
                <div className="pitch-draft-toolbar">
                  <span>
                    {
                      coverage.intervals.filter((item) =>
                        ['confirmed', 'modified'].includes(
                          record.current!.snapshot.checkpoints[checkpointKey(item)],
                        ),
                      ).length
                    }{' '}
                    / {coverage.intervals.length} 处已处理
                  </span>
                  <select
                    aria-label="检查点状态"
                    value={
                      coverageIndex >= 0
                        ? (record.current.snapshot.checkpoints[
                            checkpointKey(coverage.intervals[coverageIndex])
                          ] ?? 'pending')
                        : 'pending'
                    }
                    disabled={coverageIndex < 0 || draftBusy || applying}
                    onChange={(event) => {
                      if (!record.current || coverageIndex < 0) return;
                      const key = checkpointKey(coverage.intervals[coverageIndex]);
                      void commitReview(
                        changeReview(record.current, {
                          ...record.current.snapshot,
                          checkpoints: {
                            ...record.current.snapshot.checkpoints,
                            [key]: event.target.value as ReviewStatus,
                          },
                        }),
                      );
                    }}
                  >
                    {Object.entries(reviewStatusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <p className="subtle-note">
                {coverageError || coverage?.note || '只读取已保存的全段音高，不启动推理、不修改乐谱。'}
                {coverage ? ' 此处只筛选持续证据；其它局部分歧仍在转写修正提案中。' : ''}
                {coverage?.totalIntervals === 0 ? ' 当前规则未找到持续检查点，不代表转谱无误。' : ''}
                {coverage?.truncated ? ' 仅显示前400处。' : ''}
              </p>
            </div>
            <div className="pitch-window-controls">
              <button
                className="secondary-button"
                aria-label="上一个音高片段"
                onClick={() => moveWindow(start - length / 2)}
              >
                <ArrowLeft size={16} />
              </button>
              <label>
                原音频起点（秒）
                <input
                  aria-label="音高对照起始秒"
                  type="number"
                  min="0"
                  step="0.1"
                  value={positionInput}
                  onChange={(event) => setPositionInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      positionInput !== '' &&
                      Number.isFinite(Number(positionInput))
                    )
                      moveWindow(Number(positionInput));
                  }}
                />
              </label>
              <button
                className="secondary-button"
                onClick={() => {
                  if (positionInput !== '' && Number.isFinite(Number(positionInput)))
                    moveWindow(Number(positionInput));
                }}
              >
                定位
              </button>
              <label>
                显示范围
                <select
                  aria-label="音高片段时长"
                  value={length}
                  onChange={(event) => {
                    engine.current?.pause();
                    setLength(Number(event.target.value));
                  }}
                >
                  <option value="4">4 秒</option>
                  <option value="8">8 秒</option>
                  <option value="16">16 秒</option>
                </select>
              </label>
              <button
                className="secondary-button"
                aria-label="下一个音高片段"
                onClick={() => moveWindow(start + length / 2)}
              >
                <ArrowRight size={16} />
              </button>
            </div>
            <div className="pitch-legend">
              <span className="pitch-notes-key">当前音符</span>
              <span className="pitch-fcpe-key">FCPE</span>
              <span className="pitch-crepe-key">独立 CREPE</span>
              <small>
                {loading
                  ? '读取本机连续音高…'
                  : `${start.toFixed(1)}–${end.toFixed(1)} 秒 · 点击音符选择，点击空白放置拆分游标`}
              </small>
            </div>
            <div className="pitch-chart-wrap">
              <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className="pitch-chart"
                role="group"
                aria-label="原曲主唱音高与当前音符时间轴"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  engine.current?.pause();
                  placeCursor(
                    Math.max(
                      start,
                      Math.min(
                        end,
                        start +
                          ((((event.clientX - bounds.left) / bounds.width) * WIDTH - LEFT) /
                            (WIDTH - LEFT - RIGHT)) *
                            (end - start),
                      ),
                    ),
                  );
                }}
              >
                {(coverage?.intervals ?? [])
                  .filter((item) => item.startSeconds < end && item.endSeconds > start)
                  .map((item) => (
                    <rect
                      key={`coverage-${item.kind}-${item.startSeconds}`}
                      x={chart.x(Math.max(start, item.startSeconds))}
                      y={TOP}
                      width={
                        chart.x(Math.min(end, item.endSeconds)) - chart.x(Math.max(start, item.startSeconds))
                      }
                      height={HEIGHT - TOP - BOTTOM}
                      className="pitch-coverage-band"
                    >
                      <title>{pitchCoverageLabels[item.kind]}，待试听，不是已确认错误</title>
                    </rect>
                  ))}
                {Array.from({ length: chart.high - chart.low + 1 }, (_, i) => i + chart.low).map((pitch) => (
                  <g key={pitch}>
                    <line
                      x1={LEFT}
                      x2={WIDTH - RIGHT}
                      y1={chart.y(pitch)}
                      y2={chart.y(pitch)}
                      className={pitch % 12 === 0 ? 'pitch-octave-line' : 'pitch-grid-line'}
                    />
                    {(pitch % 12 === 0 || (chart.high - chart.low < 25 && pitch % 2 === 0)) && (
                      <text x={LEFT - 9} y={chart.y(pitch) + 4} textAnchor="end">
                        {pitchName(pitch)}
                      </text>
                    )}
                  </g>
                ))}
                {Array.from({ length: 5 }, (_, i) => start + ((end - start) * i) / 4).map((seconds) => (
                  <g key={seconds}>
                    <line
                      x1={chart.x(seconds)}
                      x2={chart.x(seconds)}
                      y1={TOP}
                      y2={HEIGHT - BOTTOM}
                      className="pitch-time-line"
                    />
                    <text x={chart.x(seconds)} y={HEIGHT - 6} textAnchor="middle">
                      {seconds.toFixed(1)}s
                    </text>
                  </g>
                ))}
                {notes.map(({ note, startSeconds, endSeconds }) => (
                  <rect
                    key={note.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择音符 ${pitchName(note.midi!)} ${startSeconds.toFixed(2)}至${endSeconds.toFixed(2)}秒`}
                    className={`pitch-note ${selected === note.id ? 'selected' : ''}`}
                    x={chart.x(Math.max(start, startSeconds))}
                    y={chart.y(note.midi!) - 5}
                    width={Math.max(
                      2,
                      chart.x(Math.min(end, endSeconds)) - chart.x(Math.max(start, startSeconds)),
                    )}
                    height={10}
                    rx={2}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectNote(note.id, Math.max(start, startSeconds));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectNote(note.id, Math.max(start, startSeconds));
                      }
                    }}
                  />
                ))}
                <path d={chart.fcpe} className="pitch-curve fcpe" />
                <path d={chart.crepe} className="pitch-curve crepe" />
                <line
                  x1={chart.x(Math.max(start, Math.min(end, cursorSeconds)))}
                  x2={chart.x(Math.max(start, Math.min(end, cursorSeconds)))}
                  y1={TOP - 5}
                  y2={HEIGHT - BOTTOM}
                  className="pitch-cursor"
                />
              </svg>
            </div>
            <div className="pitch-audition">
              <label>
                试听对象
                <select
                  aria-label="音高校对试听对象"
                  value={mode}
                  onChange={(event) => {
                    engine.current?.pause();
                    setMode(event.target.value as ListeningMode);
                  }}
                >
                  <option value="lead" disabled={!leadUrl}>
                    当前人声轨
                  </option>
                  <option value="backing" disabled={!backingUrl}>
                    分离伴唱
                  </option>
                  <option value="original">原录音</option>
                  <option value="notes">当前主唱谱音</option>
                </select>
              </label>
              <button className="secondary-button" disabled={audioBusy} onClick={() => void listen()}>
                {playback.playing ? <Pause size={17} /> : <Play size={17} />}
                {audioBusy ? '加载音频…' : playback.playing ? '暂停对照试听' : '循环试听此片段'}
              </button>
              <span>
                {cursorSeconds.toFixed(2)} 秒 · {project.tempo.toFixed(1)} BPM 排练速度
              </span>
              <span
                className="pitch-output"
                role="meter"
                aria-label="对照试听输出电平"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={outputPercent}
              >
                <i style={{ width: `${outputPercent}%` }} />
              </span>
            </div>
            <p className="subtle-note">
              模型曲线保留原始发声门控，断线不等于漏音。灰色音符是当前可编辑乐谱；改音不会重算或移动模型轨迹。
              手动时点以1/960拍存储；细小时值可能需要回总谱量化，不会自动改齐。
              {evidence?.integrity === 'stored_file' ? ' 此记录为历史模型文件，未包含新版缓存哈希。' : ''}
            </p>
            <div className="pitch-note-editor">
              <label className="field-label">
                校对音符
                <select
                  aria-label="校对音符"
                  value={selected}
                  onChange={(event) => {
                    const target = notes.find((item) => item.note.id === event.target.value);
                    if (target) selectNote(target.note.id, Math.max(start, target.startSeconds));
                  }}
                >
                  <option value="">选择图中的音符或从这里选择</option>
                  {notes.map(({ note, startSeconds, endSeconds }) => (
                    <option key={note.id} value={note.id}>
                      {pitchName(note.midi!)} · {startSeconds.toFixed(2)}–{endSeconds.toFixed(2)} 秒
                    </option>
                  ))}
                </select>
              </label>
              <div className="note-actions">
                <button
                  className="text-button"
                  onClick={() => {
                    engine.current?.pause();
                    setSelected('');
                    setAdding(true);
                    setOnsetInput(Math.max(start, Math.min(end, cursor)).toFixed(3));
                    setOffsetInput(
                      Math.min(
                        end,
                        Math.max(start, cursor) + 30 / (draft.originalAudio?.tempo ?? draft.tempo),
                      ).toFixed(3),
                    );
                  }}
                >
                  游标处新增音符
                </button>
                {note && (
                  <button
                    className="text-button"
                    onClick={() =>
                      updateDraft(() => {
                        const next = deleteNote(draft, { partId, noteId: selected });
                        setSelected('');
                        setAdding(false);
                        return next;
                      })
                    }
                  >
                    从草稿移除此音
                  </button>
                )}
              </div>
              {(note || adding) && (
                <>
                  <div className="pitch-edit-fields">
                    <label>
                      音高 MIDI
                      <input
                        aria-label="校对音高 MIDI"
                        type="number"
                        min="0"
                        max="127"
                        step="1"
                        value={pitchInput}
                        onChange={(event) => setPitchInput(event.target.value)}
                      />
                    </label>
                    <label>
                      起音（原音频秒）
                      <input
                        aria-label="校对起音秒"
                        type="number"
                        step="0.001"
                        value={onsetInput}
                        onChange={(event) => setOnsetInput(event.target.value)}
                      />
                    </label>
                    <label>
                      结束（原音频秒）
                      <input
                        aria-label="校对结束秒"
                        type="number"
                        step="0.001"
                        value={offsetInput}
                        onChange={(event) => setOffsetInput(event.target.value)}
                      />
                    </label>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        updateDraft(() => {
                          if ([pitchInput, onsetInput, offsetInput].some((value) => value.trim() === ''))
                            throw new Error('请填完整音高与起止时间。');
                          if (adding) {
                            const result = insertNoteFromSourceTime(
                              draft,
                              partId,
                              Number(pitchInput),
                              Number(onsetInput),
                              Number(offsetInput),
                            );
                            setSelected(result.selection.noteId);
                            setAdding(false);
                            return result.project;
                          }
                          return editNoteFromSourceTime(
                            draft,
                            partId,
                            selected,
                            Number(pitchInput),
                            Number(onsetInput),
                            Number(offsetInput),
                          );
                        })
                      }
                    >
                      {adding ? '新增至草稿' : '更新草稿'}
                    </button>
                  </div>
                  {note && (
                    <div className="pitch-model-values">
                      <span>
                        该音符范围内模型 MIDI 中值：FCPE {modelMedian('fcpeMidi')} / CREPE{' '}
                        {modelMedian('crepeMidi')}
                      </span>
                      <label>
                        拆分游标（秒）
                        <input
                          aria-label="拆分游标秒"
                          type="number"
                          step="0.001"
                          value={cursorInput}
                          onChange={(event) => setCursorInput(event.target.value)}
                          onBlur={commitCursor}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitCursor();
                          }}
                        />
                      </label>
                      <button
                        className="text-button"
                        onClick={() =>
                          updateDraft(() => {
                            if (cursorInput.trim() === '') throw new Error('请填写拆分游标时间。');
                            return splitNoteAtSourceTime(draft, partId, selected, Number(cursorInput));
                          })
                        }
                      >
                        <Scissors size={15} />
                        在游标拆分
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            {hasArrangement && (
              <p className="pitch-arrangement-note">
                已有阿卡贝拉编配不会被覆盖。应用原曲修正后，可回到编配界面重新生成或继续手动编辑。
              </p>
            )}
          </>
        )}
        {error && (
          <div className="error-message" role="alert">
            <WarningCircle size={18} />
            {error}
          </div>
        )}
        <div className="modal-actions">
          <span className="pitch-change-count">本次草稿 {changed} 个音符变化 · 应用前不写入工程</span>
          <button
            className="secondary-button"
            disabled={!ready || applying || draftBusy || Boolean(conflict)}
            onClick={() => setDiscarding(true)}
          >
            放弃草稿
          </button>
          <button className="secondary-button" disabled={applying} onClick={() => void keepAndClose()}>
            保留草稿并返回
          </button>
          <button
            className="primary-button"
            disabled={
              !ready ||
              Boolean(conflict) ||
              draftBusy ||
              applying ||
              Boolean(draftError) ||
              (!changed &&
                JSON.stringify(record.current?.snapshot.checkpoints ?? {}) ===
                  JSON.stringify(project.pitchReview?.checkpoints ?? {}))
            }
            onClick={async () => {
              engine.current?.pause();
              setApplying(true);
              try {
                await writes.current;
                await onApply(reviewProject(record.current!, project));
                await deleteReviewDraft(project.id);
                onClose();
              } catch (cause) {
                setDraftError(`应用未完成，草稿保留：${cause instanceof Error ? cause.message : cause}`);
              } finally {
                setApplying(false);
              }
            }}
          >
            <Check size={17} />
            应用到原曲
          </button>
        </div>
        {discarding && (
          <div className="library-delete-confirm" role="alert">
            <span>放弃未应用的修改和本次检查进度？正式乐谱保持不变。</span>
            <button className="secondary-button" onClick={() => setDiscarding(false)}>
              继续校对
            </button>
            <button
              className="secondary-button"
              disabled={draftBusy || applying}
              onClick={async () => {
                try {
                  await writes.current;
                  await deleteReviewDraft(project.id);
                  onClose();
                } catch (cause) {
                  setDraftError(`未能删除草稿：${cause instanceof Error ? cause.message : cause}`);
                }
              }}
            >
              确认放弃
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
