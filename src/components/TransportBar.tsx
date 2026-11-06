import { useEffect, useRef, useState } from 'react';
import {
  CircleNotch,
  Headphones,
  Metronome,
  MusicNotes,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SpeakerHigh,
  Stop,
} from '@phosphor-icons/react';
import type { PlaybackMode, PlaybackState } from '../lib/audio';
import { metronomeGrid } from '../lib/audio';
import type { ScoreProject } from '../lib/types';
import { beatsPerBar } from '../lib/music';
import { timeLabel } from './Waveform';

function NumberSetting({
  value,
  min,
  max,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const displayValue = (input: number) => String(Math.round(input * 100) / 100);
  const [draft, setDraft] = useState(displayValue(value));
  const cancelled = useRef(false);
  useEffect(() => setDraft(displayValue(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    const next = draft.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
    setDraft(displayValue(next));
    if (draft !== displayValue(value) && next !== value) onCommit(next);
  };
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = true;
          setDraft(displayValue(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

interface Props {
  project: ScoreProject;
  state: PlaybackState;
  mode: PlaybackMode;
  busy: boolean;
  audioReady: boolean;
  stemName?: string;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  metronome: boolean;
  countIn: boolean;
  onMode: (mode: PlaybackMode) => void;
  onPlay: (shouldPlay: boolean) => void;
  onStop: () => void;
  onPrevious: () => void;
  onTempo: (tempo: number) => void;
  onMetronome: () => void;
  onCountIn: (enabled: boolean) => void;
  onLoop: () => void;
  onRange: (start: number, end: number) => void;
}

export default function TransportBar({
  project,
  state,
  mode,
  busy,
  audioReady,
  stemName,
  loop,
  loopStart,
  loopEnd,
  metronome,
  countIn,
  onMode,
  onPlay,
  onStop,
  onPrevious,
  onTempo,
  onMetronome,
  onCountIn,
  onLoop,
  onRange,
}: Props) {
  const playIntent = useRef<boolean | undefined>(undefined);
  const barLength = beatsPerBar(project);
  const currentBar = Math.min(project.measures, Math.floor(state.beat / barLength) + 1);
  const sourceTempo = project.originalAudio?.tempo ?? project.tempo;
  const scoreSeconds = (project.measures * barLength * 60) / project.tempo;
  const currentSeconds =
    mode === 'source'
      ? (state.beat * 60) / sourceTempo + (project.originalAudio?.offsetSeconds ?? 0)
      : (state.beat * 60) / project.tempo;
  const grid = metronomeGrid(project);
  const beatIndex = Math.floor((state.beat % barLength) / grid.step);
  return (
    <footer className={`transport ${state.playing ? 'is-playing' : ''}`} aria-label="播放与排练控制">
      <div className="transport-play">
        <button
          className="icon-button previous-button"
          aria-label="上一小节"
          title="上一小节"
          onClick={onPrevious}
        >
          <SkipBack size={18} weight="fill" />
        </button>
        <button
          className={`play-button ${busy ? 'loading' : ''}`}
          aria-label={state.playing ? '暂停' : '播放'}
          disabled={busy}
          onPointerDown={() => {
            // Committing a focused tempo/range input pauses audio on blur.
            // Preserve the action the button showed when the user pressed it.
            playIntent.current = !state.playing;
          }}
          onPointerCancel={() => { playIntent.current = undefined; }}
          onKeyDown={() => { playIntent.current = undefined; }}
          onClick={() => {
            const shouldPlay = playIntent.current ?? !state.playing;
            playIntent.current = undefined;
            onPlay(shouldPlay);
          }}
        >
          {busy ? (
            <CircleNotch className="spin" size={21} />
          ) : state.playing ? (
            <Pause size={21} weight="fill" />
          ) : (
            <Play size={21} weight="fill" />
          )}
          <span>{busy ? '载入' : state.playing ? '暂停' : '播放'}</span>
        </button>
        <button className="icon-button" aria-label="停止并回到开始" title="停止并回到开始" onClick={onStop}>
          <Stop size={17} weight="fill" />
        </button>
      </div>
      <div className="position-display">
        <strong>
          {String(currentBar).padStart(2, '0')}
          <span>:{String(beatIndex + 1).padStart(2, '0')}</span>
        </strong>
        <small>
          {timeLabel(currentSeconds)} /{' '}
          {timeLabel(mode === 'source' ? (project.originalAudio?.duration ?? scoreSeconds) : scoreSeconds)}
        </small>
      </div>
      <div className="transport-mode" aria-label="试听来源">
        <button
          aria-label="选择谱曲播放"
          aria-pressed={mode === 'score'}
          className={mode === 'score' ? 'selected' : ''}
          onClick={() => onMode('score')}
        >
          <MusicNotes size={15} />
          <span>谱曲</span>
        </button>
        <button
          aria-label="选择原音频播放"
          aria-pressed={mode === 'source'}
          className={mode === 'source' ? 'selected' : ''}
          disabled={!audioReady}
          onClick={() => onMode('source')}
        >
          <Headphones size={15} />
          <span>{stemName && mode === 'source' ? '分轨' : '原音频'}</span>
        </button>
      </div>
      <div className="transport-tempo">
        <label className="tempo-control">
          <span>速度</span>
          <NumberSetting value={project.tempo} min={30} max={240} label="播放速度 BPM" onCommit={onTempo} />
          <small>BPM</small>
        </label>
        <div className="beat-dots" aria-hidden="true">
          {Array.from({ length: Math.ceil(barLength / grid.step) }, (_, i) => (
            <i key={i} className={state.playing && i === beatIndex ? 'current' : ''} />
          ))}
        </div>
      </div>
      <div className="transport-timing">
        <button
          className={`metronome-control ${metronome ? 'enabled' : ''}`}
          aria-label="节拍器"
          aria-pressed={metronome}
          onClick={onMetronome}
        >
          <Metronome size={19} />
          <span>节拍器</span>
        </button>
        <label className="count-in">
          <input type="checkbox" checked={countIn} onChange={(event) => onCountIn(event.target.checked)} />
          预备拍
        </label>
      </div>
      <div className={`loop-controls ${loop ? 'enabled' : ''}`}>
        <button
          className="loop-toggle"
          aria-label="小节循环"
          aria-pressed={loop}
          title="循环选中的小节"
          onClick={onLoop}
        >
          <Repeat size={19} />
          <span>循环</span>
        </button>
        <NumberSetting
          value={loopStart}
          min={1}
          max={loopEnd}
          label="循环开始小节"
          onCommit={(value) => onRange(Math.round(value), loopEnd)}
        />
        <span className="range-to">至</span>
        <NumberSetting
          value={loopEnd}
          min={loopStart}
          max={project.measures}
          label="循环结束小节"
          onCommit={(value) => onRange(loopStart, Math.round(value))}
        />
      </div>
      <div className="output-meter" aria-label="实时音频电平">
        <div>
          <SpeakerHigh size={17} />
          <span>{state.playing ? '输出中' : '音频输出'}</span>
        </div>
        <div className="meter-bars">
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} className={state.peak * 28 > i ? 'lit' : ''} />
          ))}
        </div>
      </div>
    </footer>
  );
}
