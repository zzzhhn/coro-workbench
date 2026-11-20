import { arrangementMethods, type ArrangementEngine } from '../lib/arrangementEngines';
import { useId, useState } from 'react';
import { ArrowRight, Check, LockSimple, MusicNotes, Sparkle, X } from '@phosphor-icons/react';
import Modal from './Modal';
import type { ArrangementOptions, MeasureLock, ScoreProject } from '../lib/types';
import { recommendLeadPart } from '../lib/arrange';
import { chantSourceOptions, defaultChantSelection } from '../lib/arrangeSourceChant';
import './arrangement-controls.css';

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
  current,
  initialOptions,
  onClose,
  onArrange,
  onLocksChange,
}: {
  project: ScoreProject;
  current?: ScoreProject;
  initialOptions?: ArrangementOptions;
  onClose: () => void;
  onArrange: (options: ArrangementOptions) => void;
  onLocksChange?: (locks: MeasureLock[]) => void;
}) {
  const [options, setOptions] = useState<ArrangementOptions>(
    initialOptions ??
      current?.arrangement?.options ??
      project.arrangement?.options ?? {
        preset: 'solo-satb',
        style: 'pop',
        difficulty: 'medium',
        percussion: false,
        transpose: 0,
        leadPartId: recommendLeadPart(project)?.id,
      },
  );
  const [locks, setLocks] = useState<MeasureLock[]>(current?.arrangement?.locks ?? []);
  const [firstBar, setFirstBar] = useState('1');
  const [lastBar, setLastBar] = useState(String(Math.min(4, current?.measures ?? project.measures)));
  const [lockError, setLockError] = useState('');
  const lockHelpId = useId();
  const lockErrorId = useId();
  const locked = locks.length > 0;
  const measureCount = current?.measures ?? project.measures;
  const changeLocks = (next: MeasureLock[]) => {
    setLocks(next);
    setLockError('');
    onLocksChange?.(next);
  };
  const addLock = () => {
    const first = Number(firstBar);
    const last = Number(lastBar);
    if (
      !firstBar.trim() || !lastBar.trim() ||
      !Number.isInteger(first) || !Number.isInteger(last) ||
      first < 1 || last > measureCount || first > last
    ) {
      setLockError(`请输入 1 至 ${measureCount} 的完整小节范围，起点不能晚于终点。`);
      return;
    }
    if (locks.some((lock) => first <= lock.last && last >= lock.first)) {
      setLockError('这段与已锁定的小节重叠，请调整范围。');
      return;
    }
    const currentOptions = current?.arrangement?.options;
    if (currentOptions && (
      options.preset !== currentOptions.preset ||
      options.transpose !== currentOptions.transpose ||
      options.leadPartId !== currentOptions.leadPartId
    )) {
      setLockError('锁定前，请将编制、主旋律和移调恢复为当前版本设置。');
      return;
    }
    changeLocks([...locks, { first, last }].sort((a, b) => a.first - b.first));
  };
  const chantOptions = chantSourceOptions(project, options.leadPartId);
  const selectedSources = (options.accompanimentIds ?? []).filter((id) => chantOptions.some((option) => option.id === id));
  const sourceChant = options.preset === 'solo-satb' && (options.engine === 'source-chant' || options.engine === 'open-chant');
  const grooveParts = project.parts.filter(part => part.id !== options.leadPartId && part.role !== 'percussion');
  const chantBlocked = sourceChant && (!selectedSources.length || !selectedSources.includes(options.bassPartId ?? ''));
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
            aria-describedby={locked ? lockHelpId : undefined}
            disabled={locked && preset.id !== options.preset}
            onClick={() => setOptions({ ...options, formPlan: preset.id === options.preset ? options.formPlan : undefined, preset: preset.id })}
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
            disabled={locked}
            aria-describedby={locked ? lockHelpId : undefined}
            onChange={(event) => setOptions({ ...options, formPlan: undefined, leadPartId: event.target.value })}
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
            disabled={locked}
            aria-describedby={locked ? lockHelpId : undefined}
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
          <select aria-label="编配方式" value={options.engine ?? 'v2'} onChange={event => {
            const engine = event.target.value as ArrangementEngine;
            if (engine !== 'source-chant' && engine !== 'open-chant') {
              setOptions({ ...options, formPlan: undefined, engine, accompanimentIds: undefined, bassPartId: undefined });
              return;
            }
            const selection = defaultChantSelection(project, options.leadPartId);
            setOptions({ ...options, formPlan: undefined, engine,
              accompanimentIds: selectedSources.length ? selectedSources : selection.accompanimentIds,
              bassPartId: selectedSources.includes(options.bassPartId ?? '') ? options.bassPartId : selection.bassPartId,
            });
          }}>
            {Object.entries(arrangementMethods).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          {options.formPlan && <button type="button" onClick={() => setOptions({ ...options, formPlan: undefined })}>
            改用自动段落计划
          </button>}
          {options.engine === 'groove' && (
            <div className="chant-sources">
              <label className="chant-source">
                <input type="checkbox" checked={options.groovePhrasing === 'responsive'}
                  onChange={event => setOptions({ ...options, groovePhrasing: event.target.checked ? 'responsive' : undefined })} />
                女高与低音随乐句变化
              </label>
              <label className="chant-bass">低音取自
                <select value={options.bassPartId ?? ''} onChange={event => setOptions({ ...options, bassPartId: event.target.value || undefined })}>
                  <option value="">自动匹配低音声部</option>
                  {grooveParts.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}
                </select>
              </label>
              {grooveParts.some(part => part.role === 'instrument' && part.id !== options.bassPartId) && <p>器乐动机来源（可选）</p>}
              {grooveParts.filter(part => part.role === 'instrument' && part.id !== options.bassPartId).map(part => (
                <label key={part.id} className="chant-source">
                  <input type="checkbox" checked={options.accompanimentIds?.includes(part.id) ?? false} onChange={event => {
                    const rest = (options.accompanimentIds ?? []).filter(id => id !== part.id);
                    setOptions({ ...options, accompanimentIds: event.target.checked ? [...rest, part.id] : rest });
                  }} />{part.name}
                </label>
              ))}
            </div>
          )}
          {sourceChant && (
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
      {current?.arrangement && onLocksChange && (
        <section className="arrange-locks" aria-label="锁定小节">
          <div className="arrange-locks-heading">
            <strong><LockSimple size={16} /> 锁定小节</strong>
            {locked && <button className="text-button" onClick={() => changeLocks([])}>全部解锁</button>}
          </div>
          <p id={lockHelpId}>
            {locked ? '锁定段保留当前版本的音符；更改编制、主旋律或移调前需先解锁。' : '保留满意的段落，其余小节重新编配。起止小节均包含在内。'}
          </p>
          {locked && (
            <ul className="arrange-lock-list" aria-label="已锁定范围">
              {locks.map((lock) => (
                <li key={`${lock.first}-${lock.last}`}>
                  <span>第 {lock.first === lock.last ? lock.first : `${lock.first} 至 ${lock.last}`} 小节</span>
                  <button aria-label={`解锁第 ${lock.first} 至 ${lock.last} 小节`} onClick={() => changeLocks(locks.filter((item) => item !== lock))}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="arrange-lock-editor" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addLock(); } }}>
            <label>起始小节<input type="number" min={1} max={measureCount} step={1} value={firstBar} aria-invalid={Boolean(lockError)} aria-describedby={lockError ? lockErrorId : lockHelpId} onChange={(event) => { setFirstBar(event.target.value); setLockError(''); }} /></label>
            <span aria-hidden="true">至</span>
            <label>结束小节<input type="number" min={1} max={measureCount} step={1} value={lastBar} aria-invalid={Boolean(lockError)} aria-describedby={lockError ? lockErrorId : lockHelpId} onChange={(event) => { setLastBar(event.target.value); setLockError(''); }} /></label>
            <button className="secondary-button" onClick={addLock}><LockSimple size={15} /> 锁定</button>
          </div>
          {lockError && <p className="arrange-lock-error" id={lockErrorId} role="alert">{lockError}</p>}
        </section>
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
      <div className="modal-actions arrange-actions">
        <button className="secondary-button" onClick={onClose}>
          返回总谱
        </button>
        {sourceChant && (
          <button className="secondary-button" disabled={chantBlocked} onClick={() => onArrange({ ...options, variant: (options.variant ?? 0) + 1 })}>
            <Sparkle size={17} /> 生成变体
          </button>
        )}
        <button className="primary-button" disabled={chantBlocked} onClick={() => onArrange(options)}>
          生成阿卡贝拉谱 <ArrowRight size={18} />
        </button>
      </div>
    </Modal>
  );
}
