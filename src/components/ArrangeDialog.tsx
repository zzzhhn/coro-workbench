import { useState } from 'react';
import { ArrowRight, Check, MusicNotes, Sparkle } from '@phosphor-icons/react';
import Modal from './Modal';
import type { ArrangementOptions, ScoreProject } from '../lib/types';
import { recommendLeadPart } from '../lib/arrange';

const presets = [
  {
    id: 'satb',
    label: '混声 SATB',
    sub: '女高 · 女低 · 男高 · 男低',
    detail: '经典混声编制，覆盖宽广音域。',
  },
  {
    id: 'ssaa',
    label: '女声 SSAA',
    sub: '女高 I · 女高 II · 女低 I · 女低 II',
    detail: '紧密和声，让高声部更通透。',
  },
  {
    id: 'ttbb',
    label: '男声 TTBB',
    sub: '男高 I · 男高 II · 男低 I · 男低 II',
    detail: '下移旋律，保留丰富低频层次。',
  },
] as const;

export default function ArrangeDialog({
  project,
  initialOptions,
  onClose,
  onArrange,
}: {
  project: ScoreProject;
  initialOptions?: ArrangementOptions;
  onClose: () => void;
  onArrange: (options: ArrangementOptions) => void;
}) {
  const [options, setOptions] = useState<ArrangementOptions>(
    initialOptions ??
      project.arrangement?.options ?? {
        preset: 'satb',
        style: 'pop',
        difficulty: 'medium',
        percussion: true,
        transpose: 0,
        leadPartId: recommendLeadPart(project)?.id,
      },
  );
  return (
    <Modal title="阿卡贝拉编配" eyebrow="ARRANGEMENT" onClose={onClose} wide>
      <p className="modal-description">
        保留主旋律，重新分配和声与低音，为歌者留出呼吸。这会生成一份新编配，原总谱不会被覆盖。
      </p>
      <div className="preset-grid" role="radiogroup" aria-label="合唱编制">
        {presets.map((preset) => (
          <button
            key={preset.id}
            className={`preset ${preset.id === options.preset ? 'selected' : ''}`}
            role="radio"
            aria-checked={preset.id === options.preset}
            onClick={() => setOptions({ ...options, preset: preset.id })}
          >
            <div className="voice-stacks">
              {[34, 48, 42, 29].map((height, index) => (
                <i
                  key={index}
                  style={{
                    height:
                      height + (preset.id === 'ssaa' ? index * 3 : preset.id === 'ttbb' ? -index * 3 : 0),
                  }}
                />
              ))}
            </div>
            <strong>{preset.label}</strong>
            <small>{preset.sub}</small>
            <p>{preset.detail}</p>
            {preset.id === options.preset && <Check className="preset-check" size={18} weight="bold" />}
          </button>
        ))}
      </div>
      <div className="arrange-fields">
        <label>
          主旋律来自
          <select
            value={options.leadPartId}
            onChange={(event) => setOptions({ ...options, leadPartId: event.target.value })}
          >
            {project.parts
              .filter((part) => part.role !== 'percussion')
              .map((part) => (
                <option key={part.id} value={part.id}>
                  {part.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          编配风格
          <select
            value={options.style}
            onChange={(event) =>
              setOptions({ ...options, style: event.target.value as ArrangementOptions['style'] })
            }
          >
            <option value="pop">流行 · 律动衬底</option>
            <option value="choral">合唱 · 连贯长音</option>
            <option value="jazz">爵士 · 延伸和声</option>
          </select>
        </label>
        <label>
          歌者难度
          <select
            value={options.difficulty}
            onChange={(event) =>
              setOptions({ ...options, difficulty: event.target.value as ArrangementOptions['difficulty'] })
            }
          >
            <option value="easy">入门 · 简化节奏</option>
            <option value="medium">常规 · 平衡表现力</option>
            <option value="advanced">进阶 · 更丰富的织体</option>
          </select>
        </label>
        <label>
          整体移调
          <select
            value={options.transpose}
            onChange={(event) => setOptions({ ...options, transpose: Number(event.target.value) })}
          >
            {Array.from({ length: 25 }, (_, i) => i - 12).map((value) => (
              <option key={value} value={value}>
                {value === 0 ? '原调' : `${value > 0 ? '+' : ''}${value} 半音`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="toggle-row">
        <div>
          <MusicNotes size={22} />
          <div>
            <strong>加入人声打击乐</strong>
            <p>B / ts / ka 拟声音节，与主声部分开排练</p>
          </div>
        </div>
        <input
          type="checkbox"
          checked={options.percussion}
          onChange={(event) => setOptions({ ...options, percussion: event.target.checked })}
        />
        <span className="toggle-visual" />
      </label>
      <div className="arrange-note">
        <Sparkle size={21} />
        <p>
          根据常见声域、和声连接、声部交叉和换气自动约束。默认生成拟声音节；已有歌词尽量保留，不会凭音频猜写原词。合唱音色仅用于排练音高。
        </p>
      </div>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose}>
          返回总谱
        </button>
        <button className="primary-button" onClick={() => onArrange(options)}>
          生成阿卡贝拉谱 <ArrowRight size={18} />
        </button>
      </div>
    </Modal>
  );
}
