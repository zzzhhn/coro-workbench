import { useState } from 'react';
import { ArrowRight, Check, MusicNotes, Sparkle } from '@phosphor-icons/react';
import Modal from './Modal';
import type { ArrangementOptions, ScoreProject } from '../lib/types';
import { recommendLeadPart } from '../lib/arrange';
import { chantSourceOptions, defaultChantSelection } from '../lib/arrangeSourceChant';

const presets = [
  {
    id: 'solo-satb',
    label: 'Solo + SATB',
    sub: '主唱 · 女高 · 女低 · 男高 · 男低',
    detail: '主唱原样保留，按段落安排和声与低音。',
  },
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
        preset: 'solo-satb',
        style: 'pop',
        difficulty: 'medium',
        percussion: false,
        transpose: 0,
        leadPartId: recommendLeadPart(project)?.id,
      },
  );
  const chantOptions = chantSourceOptions(project, options.leadPartId);
  const selectedSources = (options.accompanimentIds ?? []).filter((id) => chantOptions.some((option) => option.id === id));
  const chantBlocked = options.preset === 'solo-satb' && options.engine === 'source-chant' && (!selectedSources.length || !options.bassPartId);
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
              {(preset.id === 'solo-satb' ? [40, 34, 48, 42, 29] : [34, 48, 42, 29]).map((height, index) => (
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
      {options.preset === 'solo-satb' && (
        <fieldset className="arrange-engine" aria-label="编配方式">
          <legend>编配方式</legend>
          <label className={`arrange-engine-choice ${options.engine !== 'source-chant' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="arrange-engine"
              checked={options.engine !== 'source-chant'}
              onChange={() => setOptions({ ...options, engine: 'v2' })}
            />
            <span>
              <strong>默认编配</strong>
              <small>按段落安排背景织体与低音。</small>
            </span>
          </label>
          <label className={`arrange-engine-choice ${options.engine === 'source-chant' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="arrange-engine"
              checked={options.engine === 'source-chant'}
              onChange={() => {
                const selection = defaultChantSelection(project, options.leadPartId);
                setOptions({
                  ...options,
                  engine: 'source-chant',
                  accompanimentIds: options.accompanimentIds?.length ? options.accompanimentIds : selection.accompanimentIds,
                  bassPartId: options.bassPartId ?? selection.bassPartId,
                });
              }}
            />
            <span>
              <strong>
                源谱吟唱 <em className="experimental-tag">实验</em>
              </strong>
              <small>从原谱伴奏提取和声，背景改为长音吟唱，整首生成。只在少数片段听过，需逐段试听。</small>
            </span>
          </label>
          {options.engine === 'source-chant' && (
            <div className="chant-sources">
              <p>和声来源（从原谱伴奏读取）</p>
              {chantOptions.length === 0 && <p className="chant-empty">这份谱没有可用的伴奏声部，源谱吟唱无法使用。</p>}
              {chantOptions.map((option) => (
                <label key={option.id} className="chant-source">
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(option.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selectedSources, option.id]
                        : selectedSources.filter((id) => id !== option.id);
                      const ordered = chantOptions.map((item) => item.id).filter((id) => next.includes(id));
                      setOptions({
                        ...options,
                        accompanimentIds: ordered,
                        bassPartId: ordered.includes(options.bassPartId ?? '') ? options.bassPartId : ordered.at(-1),
                      });
                    }}
                  />
                  {option.label}
                </label>
              ))}
              {selectedSources.length > 0 && (
                <label className="chant-bass">
                  低音取自
                  <select
                    value={options.bassPartId}
                    onChange={(event) => setOptions({ ...options, bassPartId: event.target.value })}
                  >
                    {chantOptions
                      .filter((option) => selectedSources.includes(option.id))
                      .map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </fieldset>
      )}
      <label className="toggle-row">
        <div>
          <MusicNotes size={22} />
          <div>
            <strong>加入人声打击乐</strong>
            <p>B / pf / ts 拟声音节，与主声部分开排练</p>
          </div>
        </div>
        <input
          type="checkbox"
          disabled={options.preset === 'solo-satb'}
          checked={options.percussion && options.preset !== 'solo-satb'}
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
        <button className="primary-button" disabled={chantBlocked} onClick={() => onArrange(options)}>
          生成阿卡贝拉谱 <ArrowRight size={18} />
        </button>
      </div>
    </Modal>
  );
}
