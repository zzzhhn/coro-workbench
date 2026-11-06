import { ArrowUpRight, Check, Headphones, MusicNotes, Repeat } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import type { ScoreProject } from '../lib/types';
import { pitchName } from '../lib/music';
import { partRange, partRoleName, rehearsalSections } from './workspaceView';

interface Props {
  project: ScoreProject;
  focusPartId: string;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  onFocus: (partId: string) => void;
  onSolo: (partId: string) => void;
  onSection: (start: number, end: number) => void;
  onWhole: () => void;
  onEdit: () => void;
}

export default function PracticePanel({
  project,
  focusPartId,
  loop,
  loopStart,
  loopEnd,
  onFocus,
  onSolo,
  onSection,
  onWhole,
  onEdit,
}: Props) {
  const focus = project.parts.find((part) => part.id === focusPartId);
  const range = focus ? partRange(focus) : undefined;
  return (
    <section className="practice-panel" aria-label="排练设置">
      <div className="panel-section-heading">
        <h2>这次练什么</h2>
        <Headphones size={18} />
      </div>
      <p className="panel-intro">先选声部，再把难点反复唱熟。</p>
      <div className="practice-voices" role="group" aria-label="练习声部">
        <button
          className={`practice-all ${focusPartId === 'all' ? 'selected' : ''}`}
          aria-pressed={focusPartId === 'all'}
          onClick={() => onFocus('all')}
        >
          <MusicNotes size={18} />
          <span>
            完整总谱<small>{project.parts.length} 个声部</small>
          </span>
          {focusPartId === 'all' && <Check size={15} />}
        </button>
        {project.parts.map((part) => (
          <div
            className={`practice-voice ${focusPartId === part.id ? 'selected' : ''}`}
            key={part.id}
            style={{ '--channel-color': part.color } as CSSProperties}
          >
            <button
              className="practice-voice-select"
              aria-label={`练习 ${part.name}`}
              aria-pressed={focusPartId === part.id}
              onClick={() => onFocus(part.id)}
            >
              <span className="part-monogram">{part.shortName.replace(/\.$/, '').slice(0, 3)}</span>
              <span>
                <strong>{part.name.split(' · ')[0]}</strong>
                <small>{partRoleName(part)}</small>
              </span>
            </button>
            <button
              className={part.solo ? 'solo-on' : ''}
              aria-label={`${part.name} 独奏`}
              title="独奏（可多选）"
              aria-pressed={part.solo}
              onClick={() => onSolo(part.id)}
            >
              S
            </button>
          </div>
        ))}
      </div>
      <p className="panel-footnote">选声部仅切换谱面；按 S 才改变听到的声部。</p>
      <div className="practice-section-head">
        <h3>
          <Repeat size={16} />
          分段练习
        </h3>
        <button aria-pressed={!loop} onClick={onWhole}>
          全曲
        </button>
      </div>
      <div className="practice-sections" aria-label="快速循环片段">
        {rehearsalSections(project.measures).map((section) => (
          <button
            key={section.start}
            className={loop && loopStart === section.start && loopEnd === section.end ? 'selected' : ''}
            aria-label={`循环第 ${section.start} 至 ${section.end} 小节`}
            aria-pressed={loop && loopStart === section.start && loopEnd === section.end}
            onClick={() => onSection(section.start, section.end)}
          >
            <span>{String(section.start).padStart(2, '0')}</span>
            <i />
            {String(section.end).padStart(2, '0')}
          </button>
        ))}
      </div>
      <div className="practice-note">
        <span>{focus ? focus.name.split(' · ')[0] : '排练提示'}</span>
        <strong>
          {range && focus?.role !== 'percussion'
            ? `${pitchName(range[0])} – ${pitchName(range[1])}`
            : '先慢练，再合唱'}
        </strong>
        <p>
          {focus?.role === 'percussion'
            ? '鼓音是节奏参考，不是真人 beatbox。'
            : project.arrangement
              ? 'Ah 采样只提供音高参考，不会演唱歌词。请按自己的音域和气息排练。'
              : '可以先分声部熟悉原谱，也可以返回编配生成合唱版本。'}
        </p>
      </div>
      <button className="return-to-edit" onClick={onEdit}>
        需要改一个音？返回编配 <ArrowUpRight size={15} />
      </button>
    </section>
  );
}
