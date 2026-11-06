import { ArrowDown, CaretDown, Headphones, Waveform as WaveformIcon } from '@phosphor-icons/react';
import Waveform, { timeLabel } from './Waveform';

interface Props {
  open: boolean;
  onToggle: () => void;
  ready: boolean;
  busy: boolean;
  demo: boolean;
  name?: string;
  stemName?: string;
  sourceMode: boolean;
  duration: number;
  peaks: number[];
  progress: number;
  onSeek: (fraction: number) => void;
  onListen: () => void;
  onDownload: () => void;
  onImport: () => void;
}

export default function SourceReference({
  open,
  onToggle,
  ready,
  busy,
  demo,
  name,
  stemName,
  sourceMode,
  duration,
  peaks,
  progress,
  onSeek,
  onListen,
  onDownload,
  onImport,
}: Props) {
  return (
    <section className={`source-reference ${open ? 'expanded' : ''}`} aria-label="原始音频">
      <div className="source-reference-heading">
        <button
          className="source-expand"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="reference-waveform"
          aria-label={open ? '收起参考音频' : '展开参考音频'}
        >
          <WaveformIcon size={18} />
          <span>参考音频</span>
          <CaretDown size={13} />
        </button>
        <span className="source-filename">
          {busy
            ? '正在生成示例音频…'
            : stemName
              ? `当前试听：${stemName}`
              : (name ?? '导入音频，与谱面交叉校对')}
          {demo && <small>原创合成示例</small>}
        </span>
        {ready && <span className="source-duration">{timeLabel(duration)}</span>}
        {ready ? (
          <button
            className={`source-listen ${sourceMode ? 'selected' : ''}`}
            aria-label="切换到原始音频"
            aria-pressed={sourceMode}
            disabled={busy}
            onClick={onListen}
          >
            <Headphones size={16} />
            <span>{sourceMode ? '已选原音频' : '对照试听'}</span>
          </button>
        ) : (
          <button className="text-button" onClick={onImport}>
            导入音频
          </button>
        )}
        <button
          className="icon-button source-download"
          aria-label="下载原始音频"
          title="下载未经改动的原文件"
          disabled={!ready || busy}
          onClick={onDownload}
        >
          <ArrowDown size={16} />
        </button>
      </div>
      {open && (
        <div className="source-waveform-body" id="reference-waveform">
          <Waveform
            peaks={peaks}
            progress={progress}
            disabled={!ready || busy}
            duration={duration}
            onSeek={onSeek}
          />
          <p>
            {stemName
              ? '此处显示原音频波形；分离音轨沿用原曲时间线。'
              : '点击波形定位原音频；下方播放栏显示当前试听来源。'}
          </p>
        </div>
      )}
    </section>
  );
}
