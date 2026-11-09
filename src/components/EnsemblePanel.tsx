import { Eye, Headphones, Plus, SlidersHorizontal } from '@phosphor-icons/react';
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { ScorePart, ScoreProject } from '../lib/types';
import { beatsPerBar } from '../lib/music';
import { partActivity, partRoleName } from './workspaceView';

interface Props {
  project: ScoreProject;
  selectedPartId: string;
  visiblePartId: string;
  sourceMode: boolean;
  onSelect: (partId: string) => void;
  onMix: (partId: string, patch: Partial<ScorePart>) => void;
  onView: (partId: string) => void;
  onStem: (part: ScorePart) => void;
  onAdd: () => void;
}

export default function EnsemblePanel({
  project,
  selectedPartId,
  visiblePartId,
  sourceMode,
  onSelect,
  onMix,
  onView,
  onStem,
  onAdd,
}: Props) {
  const activity = useMemo(
    () =>
      new Map(
        project.parts.map((part) => [part.id, partActivity(part, project.measures * beatsPerBar(project))]),
      ),
    [project],
  );
  const solo = project.parts.some((part) => part.solo);
  return (
    <section className="ensemble-panel" aria-label="声部与混音">
      <div className="panel-section-heading">
        <h2>
          声部与混音 <span>{project.parts.length}</span>
        </h2>
        <button className="icon-button" aria-label="添加声部" title="添加声部" onClick={onAdd}>
          <Plus size={17} />
        </button>
      </div>
      <div className="mixer-caption">
        <span>声部 / 音符分布</span>
        <SlidersHorizontal size={14} />
      </div>
      <div className="part-list">
        {project.parts.map((part) => (
          <div
            key={part.id}
            className={`part-channel ${selectedPartId === part.id ? 'selected' : ''} ${part.muted || (solo && !part.solo) ? 'muted' : ''}`}
            style={{ '--channel-color': part.color } as CSSProperties}
          >
            <button
              className="part-select"
              aria-pressed={selectedPartId === part.id}
              onClick={() => onSelect(part.id)}
            >
              <span className="part-monogram">{part.shortName.replace(/\.$/, '').slice(0, 3)}</span>
              <span className="part-name">
                <strong>{part.name.split(' · ')[0]}</strong>
                <small>
                  {partRoleName(part)}
                  <span>{part.notes.filter((note) => note.midi !== null).length} 音</span>
                </small>
              </span>
            </button>
            <div className="part-activity" aria-label={`${part.name} 音符分布`}>
              {activity.get(part.id)?.map((value, index) => (
                <i
                  key={index}
                  style={{
                    height: `${Math.max(12, value * 100)}%`,
                    opacity: value ? 0.42 + value * 0.5 : 0.1,
                  }}
                />
              ))}
            </div>
            <div className="channel-controls">
              <button
                aria-label={`${part.name} 静音`}
                title="静音"
                aria-pressed={part.muted}
                className={part.muted ? 'toggled' : ''}
                onClick={() => onMix(part.id, { muted: !part.muted })}
              >
                M
              </button>
              <button
                aria-label={`${part.name} 独奏`}
                title="独奏（可多选）"
                aria-pressed={part.solo}
                className={part.solo ? 'solo-on' : ''}
                onClick={() => onMix(part.id, { solo: !part.solo })}
              >
                S
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={part.volume}
                aria-label={`${part.name} 音量`}
                onChange={(event) => onMix(part.id, { volume: Number(event.target.value) })}
              />
              <button
                className={`channel-isolate ${visiblePartId === part.id ? 'view-on' : ''}`}
                aria-label={`单独阅览 ${part.name}`}
                aria-pressed={visiblePartId === part.id}
                title="仅看此声部，不改变混音"
                onClick={() => onView(part.id)}
              >
                <Eye size={15} />
              </button>
            </div>
            {part.stemUrl && (
              <button className="stem-button" onClick={() => onStem(part)}
                title="播放从原录音分出的音频，可能漏音或串音。试听识别乐谱请使用底部的谱曲播放。">
                <Headphones size={13} />
                原声分离试听
              </button>
            )}
          </div>
        ))}
      </div>
      <p className={sourceMode ? 'mixer-warning' : 'panel-footnote'}>
        {sourceMode
          ? '当前听原音频；这里的 M / S 和推子仅控制谱曲。'
          : 'M 静音　S 独奏　眼睛图标只改变阅览范围'}
      </p>
    </section>
  );
}
