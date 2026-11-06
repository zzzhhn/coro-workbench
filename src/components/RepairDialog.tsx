import { useMemo, useState } from 'react';
import { Check, WarningCircle } from '@phosphor-icons/react';
import Modal from './Modal';
import type { ScoreProject } from '../lib/types';
import {
  applyPartLyrics,
  quantizeSelection,
  reinterpretBeatUnit,
  setPartStaffLayout,
  transposeSelection,
} from '../lib/scoreTools';
import type { StaffLayout } from '../lib/scoreTools';

export default function RepairDialog({
  project,
  partId,
  currentMeasure,
  onApply,
  onClose,
  initialOperation = 'staff',
  initialFactor = 0.5,
}: {
  project: ScoreProject;
  partId: string;
  currentMeasure: number;
  onApply: (project: ScoreProject) => void;
  onClose: () => void;
  initialOperation?: 'transpose' | 'quantize' | 'staff' | 'lyrics' | 'beat';
  initialFactor?: 0.5 | 2;
}) {
  const [operation, setOperation] = useState<'transpose' | 'quantize' | 'staff' | 'lyrics' | 'beat'>(
    initialOperation,
  );
  const [selectedPart, setSelectedPart] = useState(partId);
  const [start, setStart] = useState(currentMeasure);
  const [end, setEnd] = useState(currentMeasure);
  const [semitones, setSemitones] = useState(0);
  const [grid, setGrid] = useState(0.5);
  const [layout, setLayout] = useState<StaffLayout>('auto');
  const [split, setSplit] = useState(60);
  const [lyrics, setLyrics] = useState('');
  const [factor, setFactor] = useState<0.5 | 2>(initialFactor);
  const preview = useMemo(() => {
    try {
      const selection = {
        partIds: selectedPart === 'all' ? project.parts.map((part) => part.id) : [selectedPart],
        startMeasure: start,
        endMeasure: end,
      };
      const result =
        operation === 'transpose'
          ? transposeSelection(project, selection, semitones)
          : operation === 'quantize'
            ? quantizeSelection(project, selection, grid)
            : operation === 'staff'
              ? setPartStaffLayout(project, selectedPart, layout, split)
              : operation === 'lyrics'
                ? applyPartLyrics(project, selectedPart, start, end, lyrics)
                : reinterpretBeatUnit(project, factor);
      return { result, error: '' };
    } catch (error) {
      return { result: undefined, error: error instanceof Error ? error.message : '无法生成预览。' };
    }
  }, [project, selectedPart, start, end, operation, semitones, grid, layout, split, lyrics, factor]);
  return (
    <Modal title="乐谱整理与批量校正" eyebrow="SCORE TOOLS" onClose={onClose} wide>
      <p className="modal-description">
        参考专业打谱软件的选区、谱表和量化流程。先看改动范围，再应用；所有操作都可以撤销，不会修改原音频。
      </p>
      <label className="field-label">
        操作
        <select
          value={operation}
          aria-label="整理操作"
          onChange={(event) => {
            setOperation(event.target.value as typeof operation);
            if (selectedPart === 'all') setSelectedPart(partId);
          }}
        >
          <option value="staff">整理高低音谱表</option>
          <option value="transpose">选区移调 / 修正八度</option>
          <option value="quantize">选区节奏量化</option>
          <option value="lyrics">批量填写歌词 / 拟音</option>
          <option value="beat">半速 / 倍速节拍重解释</option>
        </select>
      </label>
      {operation !== 'beat' && (
        <label className="field-label">
          声部
          <select
            aria-label="整理声部"
            value={selectedPart}
            onChange={(event) => setSelectedPart(event.target.value)}
          >
            {['transpose', 'quantize'].includes(operation) && <option value="all">全部声部</option>}
            {project.parts.map((part) => (
              <option key={part.id} value={part.id}>
                {part.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {['transpose', 'quantize', 'lyrics'].includes(operation) && (
        <div className="repair-fields">
          <label className="field-label">
            从第几小节
            <input
              type="number"
              aria-label="整理开始小节"
              min={1}
              max={project.measures}
              value={start}
              onChange={(event) => setStart(Number(event.target.value))}
            />
          </label>
          <label className="field-label">
            到第几小节
            <input
              type="number"
              aria-label="整理结束小节"
              min={start}
              max={project.measures}
              value={end}
              onChange={(event) => setEnd(Number(event.target.value))}
            />
          </label>
        </div>
      )}
      {operation === 'transpose' && (
        <label className="field-label">
          移动半音
          <select
            aria-label="移调半音"
            value={semitones}
            onChange={(event) => setSemitones(Number(event.target.value))}
          >
            {Array.from({ length: 49 }, (_, index) => index - 24).map((value) => (
              <option key={value} value={value}>
                {value > 0 ? '+' : ''}
                {value} 半音{Math.abs(value) === 12 ? '（八度）' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {operation === 'quantize' && (
        <label className="field-label">
          对齐网格
          <select
            aria-label="量化网格"
            value={grid}
            onChange={(event) => setGrid(Number(event.target.value))}
          >
            <option value={1}>四分音符</option>
            <option value={0.5}>八分音符</option>
            <option value={0.25}>十六分音符</option>
            <option value={1 / 3}>八分三连音</option>
            <option value={1 / 6}>十六分三连音</option>
          </select>
        </label>
      )}
      {operation === 'staff' && (
        <div className="repair-fields">
          <label className="field-label">
            谱表布局
            <select
              aria-label="谱表布局"
              value={layout}
              onChange={(event) => setLayout(event.target.value as StaffLayout)}
            >
              <option value="auto">自动判定</option>
              <option value="grand">高低音双谱表</option>
              <option value="treble">单高音谱表</option>
              <option value="bass">单低音谱表</option>
            </select>
          </label>
          {layout === 'grand' && (
            <label className="field-label">
              分手音高（MIDI）
              <input
                type="number"
                min={21}
                max={108}
                value={split}
                onChange={(event) => setSplit(Number(event.target.value))}
              />
              <small>60 = 中央 C，低于此音进入低音谱表</small>
            </label>
          )}
        </div>
      )}
      {operation === 'lyrics' && (
        <label className="field-label">
          音节，用空格分开
          <textarea
            className="lyrics-editor"
            aria-label="批量歌词"
            value={lyrics}
            onChange={(event) => setLyrics(event.target.value)}
            placeholder="da da doo ah 或按音节分开的歌词"
          />
          <small>按起音顺序填写；和弦同起点只填最高音。不自动猜写原歌词。</small>
        </label>
      )}
      {operation === 'beat' && (
        <label className="field-label">
          保持实际秒数不变
          <select
            aria-label="节拍重解释"
            value={factor}
            onChange={(event) => setFactor(Number(event.target.value) as 0.5 | 2)}
          >
            <option value={0.5}>
              半速记谱：{project.tempo} → {project.tempo / 2} BPM
            </option>
            <option value={2}>
              倍速记谱：{project.tempo} → {project.tempo * 2} BPM
            </option>
          </select>
          <small>重解释节拍单位，不是慢放。音符、和弦和原音频映射一起缩放。</small>
        </label>
      )}
      <div className="repair-preview" aria-live="polite">
        {preview.error ? (
          <>
            <WarningCircle size={17} /> {preview.error}
          </>
        ) : (
          <>
            <strong>将更新 {preview.result?.changedNotes ?? 0} 个音符</strong>
            <p>
              {operation === 'staff'
                ? '谱表归属变化，不改变音高或播放时间。'
                : operation === 'beat'
                  ? '整个工程的拍数单位改变；音乐实际播放时间保持一致。'
                  : `选中第 ${start}–${end} 小节内起音的音符；其他声部和小节不变。`}
            </p>
            {preview.result?.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </>
        )}
      </div>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose}>
          取消
        </button>
        <button
          className="primary-button"
          disabled={!preview.result}
          onClick={() => {
            if (preview.result) {
              onApply(preview.result.project);
              onClose();
            }
          }}
        >
          应用到当前乐谱 <Check size={17} />
        </button>
      </div>
    </Modal>
  );
}
