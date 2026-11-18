import { ArrowsLeftRight, LockSimple } from '@phosphor-icons/react';
import { useMemo } from 'react';
import type { ScoreProject } from '../lib/types';
import { chantSourceOptions } from '../lib/arrangeSourceChant';
import './arrangement-controls.css';

export default function ArrangementVersionBar({
  source,
  current,
  previous,
  onSwitch,
}: {
  source: ScoreProject;
  current: ScoreProject;
  previous?: ScoreProject;
  onSwitch: () => void;
}) {
  const arrangement = current.arrangement;
  const candidates = useMemo(() => chantSourceOptions(source, arrangement?.options.leadPartId),
    [source, arrangement?.options.leadPartId]);
  if (!arrangement) return null;

  const revision = arrangement.revision ?? 1;
  const otherRevision = previous?.arrangement?.revision ?? 1;
  const isLatest = !previous || revision >= otherRevision;
  const options = arrangement.options;
  const sourceChant = options.preset === 'solo-satb' && options.engine === 'source-chant';
  const sourceName = (id: string) => candidates.find((candidate) => candidate.id === id)?.label ?? '来源声部已不可用';
  const harmony = sourceChant
    ? options.accompanimentIds?.length ? options.accompanimentIds.map(sourceName).join('、') : '未记录'
    : '按段落生成';
  const bass = sourceChant ? options.bassPartId ? sourceName(options.bassPartId) : '未记录' : '自动生成';
  const locks = arrangement.locks ?? [];

  return (
    <section className="arrangement-version-bar" aria-label="编配版本与试听">
      <div className="arrangement-version-info">
        <div className="arrangement-version-heading">
          <strong>{isLatest ? '当前版' : '上一版'} <span>V{revision}</span></strong>
          <span className="arrangement-method">{sourceChant ? '源谱吟唱' : '默认编配'}{sourceChant && !!options.variant && ` · 变体 ${options.variant}`}</span>
        </div>
        <dl className="arrangement-version-sources">
          <div><dt>和声</dt><dd>{harmony}</dd></div>
          <div><dt>低音</dt><dd>{bass}</dd></div>
        </dl>
        {locks.length > 0 && (
          <p className="arrangement-version-locks">
            <LockSimple size={13} aria-hidden="true" />
            <span>已锁定第 {locks.map((lock) => lock.first === lock.last ? `${lock.first}` : `${lock.first} 至 ${lock.last}`).join('、')} 小节</span>
          </p>
        )}
      </div>
      <div className="arrangement-version-actions">
        {previous?.arrangement && (
          <button className="secondary-button" onClick={onSwitch} aria-label={`切换至${isLatest ? '上一版' : '当前版'} V${otherRevision} 试听`}>
            <ArrowsLeftRight size={15} /> 试听 V{otherRevision}
          </button>
        )}
      </div>
    </section>
  );
}
