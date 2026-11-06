import {
  CaretDown,
  CaretUp,
  CheckCircle,
  Copy,
  MusicNote,
  NotePencil,
  SpeakerHigh,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import type { NoteEvent, ScorePart, ScoreProject } from '../lib/types';
import type { Selection } from '../lib/editor';
import { beatsPerBar, pitchName } from '../lib/music';
import { inspectArrangement } from '../lib/arrange';
import { playbackInstruments } from '../lib/instruments';

export const durationOptions = [
  { value: 4, label: '全音符', symbol: '𝅝' },
  { value: 3, label: '附点二分', symbol: '𝅗𝅥·' },
  { value: 2, label: '二分音符', symbol: '𝅗𝅥' },
  { value: 1.5, label: '附点四分', symbol: '♩·' },
  { value: 1, label: '四分音符', symbol: '♩' },
  { value: 0.75, label: '附点八分', symbol: '♪·' },
  { value: 0.5, label: '八分音符', symbol: '♪' },
  { value: 0.25, label: '十六分音符', symbol: '♬' },
  { value: 0.125, label: '三十二分音符', symbol: '1/32' },
  { value: 0.0625, label: '六十四分音符', symbol: '1/64' },
  { value: 1 / 3, label: '八分三连音', symbol: '3' },
];

export const durationGlyphs: Record<number, string> = {
  4: '\ue1d2',
  2: '\ue1d3',
  1: '\ue1d5',
  0.5: '\ue1d7',
  0.25: '\ue1d9',
};

interface Props {
  project: ScoreProject;
  selection?: Selection;
  part: ScorePart;
  tab: 'note' | 'check';
  onTabChange: (tab: 'note' | 'check') => void;
  onChangeNote: (patch: Partial<NoteEvent>) => void;
  onChangePart: (patch: Partial<ScorePart>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onAudition: (midi: number) => void;
  onSelect: (selection: Selection) => void;
}

export default function Inspector({
  project,
  selection,
  part,
  tab,
  onTabChange: setTab,
  onChangeNote,
  onChangePart,
  onDelete,
  onDuplicate,
  onAudition,
  onSelect,
}: Props) {
  const note = selection ? part.notes.find((note) => note.id === selection.noteId) : undefined;
  const [lyric, setLyric] = useState(note?.lyric ?? '');
  useEffect(() => setLyric(note?.lyric ?? ''), [note?.id, note?.lyric]);
  const duration = note
    ? durationOptions.find((option) => Math.abs(option.value - note.duration) < 0.001)
    : undefined;
  const lowConfidence = project.parts.flatMap((part) =>
    part.notes
      .filter((note) => note.confidence !== undefined && note.confidence < 0.6)
      .map((note) => ({ part, note })),
  );
  const outOfRange = project.parts.flatMap((part) =>
    part.range
      ? part.notes
          .filter((note) => note.midi !== null && (note.midi < part.range![0] || note.midi > part.range![1]))
          .map((note) => ({ part, note }))
      : [],
  );
  const liveInspection = useMemo(
    () => (project.arrangement ? inspectArrangement(project) : undefined),
    [project],
  );
  const warnings = [
    ...new Set([
      ...(project.arrangement?.report.warnings ?? []).filter(
        (warning) => !liveInspection || !warning.includes('连续乐句超过'),
      ),
      ...(liveInspection?.warnings ?? []),
      ...project.source.warnings,
    ]),
  ];
  const pitches = part.notes.map((note) => note.midi).filter((midi): midi is number => midi !== null);
  const keyBase = note?.midi !== null && note?.midi !== undefined ? Math.floor(note.midi / 12) * 12 : 60;
  return (
    <aside className="inspector" aria-label="乐谱检查器">
      <div className="inspector-tabs" role="tablist" aria-label="属性面板">
        <button role="tab" aria-selected={tab === 'note'} onClick={() => setTab('note')}>
          音符与声部
        </button>
        <button role="tab" aria-selected={tab === 'check'} onClick={() => setTab('check')}>
          校对 <span>{lowConfidence.length + outOfRange.length || ''}</span>
        </button>
      </div>
      <div className="inspector-content">
        {tab === 'check' ? (
          <>
            <div className="check-intro">
              <CheckCircle size={25} />
              <h3>排练前检查</h3>
              <p>自动检查能发现问题，但不能替代指挥与歌者的试听。</p>
            </div>
            <div className="check-metrics">
              <div>
                <strong>{lowConfidence.length}</strong>
                <span>低置信音符</span>
              </div>
              <div>
                <strong>{outOfRange.length}</strong>
                <span>声域外音符</span>
              </div>
            </div>
            {liveInspection?.breathing && (
              <section className="breathing-check" aria-label="人声换气检查">
                <h4>连续乐句 · 按当前排练速度</h4>
                {liveInspection.breathing.map((voice) => (
                  <div key={voice.partId}>
                    <span>{project.parts.find((item) => item.id === voice.partId)?.shortName}</span>
                    <strong className={voice.phrasesOverTarget ? 'breathing-over' : ''}>
                      {voice.longestPhraseSeconds.toFixed(1)} 秒
                    </strong>
                    <small>目标 ≤ {voice.targetSeconds} 秒</small>
                  </div>
                ))}
                <p>
                  至少0.3秒无音才计为换气间隙。仅供排练提示，不代表每位歌者的气息能力；调快或调慢后会重新计算。
                </p>
              </section>
            )}
            {project.arrangement?.report.changes.map((change, index) => (
              <p key={index} className="check-change">
                <CheckCircle size={15} />
                {change}
              </p>
            ))}
            {project.source.detectedInstruments && project.source.detectedInstruments.length > 0 && (
              <section className="instrument-candidates">
                <h4>音色类别候选</h4>
                {project.source.detectedInstruments.map((candidate, index) => (
                  <div key={`${candidate.name}-${index}`}>
                    <span>{candidate.name}</span>
                    <small>激活 {candidate.confidence.toFixed(2)}</small>
                  </div>
                ))}
                <p>来自音频分类抽样，不代表已分离的声部或存在概率。</p>
              </section>
            )}
            {warnings.map((warning, index) => (
              <div className="check-warning" key={index}>
                <WarningCircle size={17} />
                <p>{warning}</p>
              </div>
            ))}
            {lowConfidence.slice(0, 30).map(({ note, part }) => (
              <button
                className="review-note"
                key={note.id}
                onClick={() => {
                  onSelect({ partId: part.id, noteId: note.id });
                  setTab('note');
                }}
              >
                <span>
                  {part.shortName} · 第 {Math.floor(note.start / beatsPerBar(project)) + 1} 小节
                </span>
                <strong>
                  {note.midi === null ? '休止' : pitchName(note.midi)}{' '}
                  <small>{Math.round((note.confidence ?? 0) * 100)} 分</small>
                </strong>
              </button>
            ))}
            <p className="subtle-note">
              置信分是模型内部得分，未经校准，不等于准确率。仪器标签同样只是候选。
            </p>
          </>
        ) : (
          <>
            <div className="inspector-label">
              <span>选中{note ? '音符' : '声部'}</span>
              <NotePencil size={16} />
            </div>
            {note ? (
              <>
                <div className="selected-pitch">
                  <div>
                    <h3>{note.midi === null ? '休止符' : pitchName(note.midi)}</h3>
                    <p>
                      {part.shortName} · 第 {Math.floor(note.start / beatsPerBar(project)) + 1} 小节 · 第{' '}
                      {+((note.start % beatsPerBar(project)) + 1).toFixed(3)} 拍
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="试听选中音符"
                    disabled={note.midi === null}
                    onClick={() => {
                      if (note.midi !== null) onAudition(note.midi);
                    }}
                  >
                    <SpeakerHigh size={21} />
                  </button>
                </div>
                <div className="pitch-adjust">
                  <button
                    onClick={() => onChangeNote({ midi: (note.midi ?? 60) - 1 })}
                    title="降低半音 (↓)"
                    aria-label="降低半音"
                  >
                    <CaretDown size={17} />
                  </button>
                  <span>{note.midi === null ? 'REST' : `MIDI ${note.midi}`}</span>
                  <button
                    onClick={() => onChangeNote({ midi: (note.midi ?? 60) + 1 })}
                    title="升高半音 (↑)"
                    aria-label="升高半音"
                  >
                    <CaretUp size={17} />
                  </button>
                </div>
                {part.notes.filter(
                  (other) => other.midi !== null && Math.abs(other.start - note.start) < 0.001,
                ).length > 1 && (
                  <div className="chord-note-picker" aria-label="同起拍音符">
                    <span>同起拍叠音</span>
                    <div>
                      {part.notes
                        .filter((other) => other.midi !== null && Math.abs(other.start - note.start) < 0.001)
                        .map((other) => (
                          <button
                            key={other.id}
                            className={other.id === note.id ? 'selected' : ''}
                            onClick={() => onSelect({ partId: part.id, noteId: other.id })}
                            aria-label={`选择同拍音 ${pitchName(other.midi!)}`}
                          >
                            {pitchName(other.midi!)}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
                <label className="field-label">
                  时值
                  <select
                    aria-label="音符时值"
                    value={duration?.value ?? note.duration}
                    onChange={(event) => onChangeNote({ duration: Number(event.target.value) })}
                  >
                    {!duration && <option value={note.duration}>{note.duration.toFixed(3)} 拍</option>}
                    {durationOptions.map((option) => (
                      <option key={option.label} value={option.value}>
                        {option.symbol}　{option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  绝对起拍 <span>从 0 计数</span>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={note.start}
                    aria-label="音符起拍"
                    onChange={(event) => onChangeNote({ start: Number(event.target.value) })}
                  />
                </label>
                <label className="field-label">
                  歌词 / 拟声音节
                  <input
                    type="text"
                    aria-label="音符歌词"
                    value={lyric}
                    maxLength={80}
                    onChange={(event) => setLyric(event.target.value)}
                    onBlur={() => {
                      if (lyric !== (note.lyric ?? '')) onChangeNote({ lyric });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    placeholder="例如：doo / 啦"
                  />
                </label>
                <div className="field-pair">
                  <label className="field-label">
                    力度
                    <select
                      aria-label="音符力度"
                      value={note.dynamic ?? ''}
                      onChange={(event) =>
                        onChangeNote({ dynamic: (event.target.value as NoteEvent['dynamic']) || undefined })
                      }
                    >
                      <option value="">继承前一力度</option>
                      {['pp', 'p', 'mp', 'mf', 'f', 'ff'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label">
                    演奏法
                    <select
                      aria-label="音符演奏法"
                      value={note.articulation ?? ''}
                      onChange={(event) =>
                        onChangeNote({
                          articulation: (event.target.value as NoteEvent['articulation']) || undefined,
                        })
                      }
                    >
                      <option value="">普通</option>
                      <option value="staccato">断奏</option>
                      <option value="tenuto">保持音</option>
                      <option value="accent">重音</option>
                    </select>
                  </label>
                </div>
                <div className="note-actions">
                  <button
                    className="secondary-button"
                    onClick={() => onChangeNote({ midi: note.midi === null ? 60 : null })}
                  >
                    {note.midi === null ? '还原为音符' : '转为休止符'}
                  </button>
                  <button
                    className="icon-button"
                    aria-label="复制音符"
                    title="复制音符"
                    onClick={onDuplicate}
                  >
                    <Copy size={17} />
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label="删除音符"
                    title="删除音符 (Delete)"
                    onClick={onDelete}
                  >
                    <Trash size={17} />
                  </button>
                </div>
                <div className="piano-mini" aria-label="音高选择键盘">
                  {[0, 2, 4, 5, 7, 9, 11].map((pc, i) => (
                    <button
                      key={pc}
                      className={`piano-white ${note.midi === keyBase + pc ? 'active' : ''}`}
                      onClick={() => {
                        onChangeNote({ midi: keyBase + pc });
                        onAudition(keyBase + pc);
                      }}
                      aria-label={`设为 ${pitchName(keyBase + pc)}`}
                    >
                      <span>{['C', 'D', 'E', 'F', 'G', 'A', 'B'][i]}</span>
                    </button>
                  ))}
                  {[1, 3, 6, 8, 10].map((pc, i) => (
                    <button
                      key={pc}
                      className={`piano-black ${note.midi === keyBase + pc ? 'active' : ''}`}
                      style={{ left: `${[10.6, 24.9, 53.5, 67.8, 82.1][i]}%` }}
                      onClick={() => {
                        onChangeNote({ midi: keyBase + pc });
                        onAudition(keyBase + pc);
                      }}
                      aria-label={`设为 ${pitchName(keyBase + pc)}`}
                    />
                  ))}
                </div>
                <div className="note-provenance">
                  <span>
                    {note.origin === 'transcribed'
                      ? '机器转谱'
                      : note.origin === 'arranged'
                        ? '编配生成'
                        : note.origin === 'demo'
                          ? '原创示例'
                          : '手动编辑'}
                  </span>
                  {note.confidence !== undefined && <span>模型分 {Math.round(note.confidence * 100)}</span>}
                </div>
              </>
            ) : (
              <>
                <div className="part-overview">
                  <div className="part-symbol" style={{ background: `${part.color}15`, color: part.color }}>
                    <MusicNote size={27} />
                  </div>
                  <h3>{part.name}</h3>
                  <p>
                    {pitches.length} 个音符 ·{' '}
                    {pitches.length
                      ? `${pitchName(Math.min(...pitches))} – ${pitchName(Math.max(...pitches))}`
                      : '等待你的第一个音符'}
                  </p>
                </div>
                <label className="field-label">
                  声部名称
                  <input
                    aria-label="声部名称"
                    value={part.name}
                    onChange={(event) => onChangePart({ name: event.target.value })}
                  />
                </label>
                <label className="field-label">
                  谱号
                  <select
                    aria-label="声部谱号"
                    value={part.clef}
                    onChange={(event) => onChangePart({ clef: event.target.value as ScorePart['clef'] })}
                  >
                    <option value="treble">高音谱号</option>
                    <option value="bass">低音谱号</option>
                    <option value="alto">中音谱号</option>
                    <option value="percussion">打击乐谱号</option>
                  </select>
                </label>
                <label className="field-label">
                  播放音色
                  <select
                    aria-label="声部音色"
                    value={part.program}
                    onChange={(event) =>
                      onChangePart({
                        program: Number(event.target.value),
                        instrument:
                          playbackInstruments.find((item) => item.program === Number(event.target.value))
                            ?.bank ?? 'instrument',
                      })
                    }
                  >
                    {playbackInstruments.map((item) => (
                      <option key={item.program} value={item.program}>
                        {item.label}
                      </option>
                    ))}
                    {!playbackInstruments.some((item) => item.program === part.program) && (
                      <option value={part.program}>GM {part.program + 1}</option>
                    )}
                  </select>
                </label>
                <label className="field-label">
                  音乐角色
                  <select
                    aria-label="声部角色"
                    value={part.role}
                    onChange={(event) => onChangePart({ role: event.target.value as ScorePart['role'] })}
                  >
                    <option value="lead">主旋律</option>
                    <option value="harmony">和声</option>
                    <option value="bass">低音</option>
                    <option value="percussion">打击乐</option>
                    <option value="instrument">其他乐器</option>
                  </select>
                </label>
                <p className="editor-hint">
                  <NotePencil size={17} />
                  点击谱面的音符，即可修改音高、时值和歌词。使用工具栏的「添加音符」开始写谱。
                </p>
              </>
            )}
            {project.arrangement && (
              <div className="range-guide">
                <span>建议声域</span>
                <strong>
                  {part.range ? `${pitchName(part.range[0])} — ${pitchName(part.range[1])}` : '无固定音高'}
                </strong>
                <p>实际可唱性请与歌者确认，不仅取决于最高音和最低音。</p>
              </div>
            )}
          </>
        )}
      </div>
      <div className="inspector-bottom">
        <span>⌘ Z 撤销</span>
        <span>↑ ↓ 调整音高</span>
      </div>
    </aside>
  );
}
