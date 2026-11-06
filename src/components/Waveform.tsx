import { useEffect, useRef } from 'react';

interface Props {
  peaks: number[];
  progress: number;
  disabled?: boolean;
  duration: number;
  onSeek: (fraction: number) => void;
}

export function timeLabel(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds)) % 60).padStart(2, '0')}`;
}

export default function Waveform({ peaks, progress, disabled, duration, onSeek }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      const context = canvas.getContext('2d');
      if (!context) return;
      const tokens = getComputedStyle(canvas);
      const played = tokens.getPropertyValue('--wave-played').trim() || '#7b8088';
      const pending = tokens.getPropertyValue('--wave-pending').trim() || '#bbc0c7';
      const cursor = tokens.getPropertyValue('--score-selection').trim() || '#b45a39';
      context.scale(ratio, ratio);
      context.clearRect(0, 0, rect.width, rect.height);
      const count = Math.floor(rect.width / 3);
      for (let index = 0; index < count; index++) {
        const value = peaks.length ? peaks[Math.floor((index / count) * peaks.length)] : 0;
        const height = Math.max(2, value * (rect.height - 7));
        context.fillStyle = index / count < progress ? played : disabled ? '#dfe1e5' : pending;
        context.fillRect(index * 3, (rect.height - height) / 2, 1.7, height);
      }
      if (!disabled) {
        context.fillStyle = cursor;
        context.fillRect(progress * rect.width, 0, 1.5, rect.height);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, progress, disabled]);

  return (
    <div className={`waveform ${disabled ? 'disabled' : ''}`}>
      <canvas
        ref={ref}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="原始音频时间轴"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(progress * duration)}
        aria-disabled={disabled}
        onClick={(event) => {
          if (!disabled) {
            const bounds = event.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)));
          }
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            onSeek(
              Math.max(
                0,
                Math.min(1, progress + (event.key === 'ArrowRight' ? 5 : -5) / Math.max(1, duration)),
              ),
            );
          }
        }}
      />
      <div className="wave-labels">
        <span>{timeLabel(progress * duration)}</span>
        <span>{timeLabel(duration)}</span>
      </div>
    </div>
  );
}
