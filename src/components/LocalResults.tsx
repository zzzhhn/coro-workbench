import { useEffect, useState } from 'react';
import { ArrowRight, CircleNotch, FileAudio, WarningCircle } from '@phosphor-icons/react';
import { getJob, jsonResponse } from '../lib/api';
import type { ScoreProject } from '../lib/types';

interface ProjectRow {
  id: string;
  title: string;
  filename: string;
  tempo: number;
  measures: number;
  parts: number;
  duration: number;
  analyzedSeconds: number;
  mode: string;
  decoder: string;
  proposal: boolean;
  uncertainRegions: number;
}

export default function LocalResults({
  currentId,
  onOpen,
}: {
  currentId: string;
  onOpen: (project: ScoreProject) => void;
}) {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string>();
  useEffect(() => {
    let active = true;
    void fetch('/api/projects?limit=40')
      .then((response) => jsonResponse<{ projects: ProjectRow[] }>(response))
      .then((result) => {
        if (active) setRows(result.projects);
      })
      .catch((error) => {
        if (active) setError(error instanceof Error ? error.message : '读取本地分析结果失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const open = async (row: ProjectRow) => {
    setOpening(row.id);
    setError('');
    try {
      const result = await getJob(row.id);
      if (!result.project) throw new Error('这项分析没有可读乐谱。');
      onOpen(result.project);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取失败');
    } finally {
      setOpening(undefined);
    }
  };
  return (
    <section className="local-results">
      <h3>本机转谱结果</h3>
      <p>每次处理都单独保留。打开结果不会删除当前工程；“待定”不是已修正的正确音。</p>
      {loading && <span className="subtle-note">读取本地结果…</span>}
      {error && (
        <div className="error-message">
          <WarningCircle size={16} />
          {error}
        </div>
      )}
      <div className="local-result-list">
        {rows.map((row) => (
          <button
            key={row.id}
            className={row.id === currentId ? 'current' : ''}
            disabled={Boolean(opening)}
            onClick={() => void open(row)}
          >
            <FileAudio size={19} />
            <span>
              <strong>{row.title}</strong>
              <small>
                {row.analyzedSeconds <= 0
                  ? '分析时长未记录'
                  : row.analyzedSeconds >= row.duration - 0.5
                    ? '整曲'
                    : `前 ${Math.round(row.analyzedSeconds)} 秒`}{' '}
                · {row.measures} 小节 · {row.parts} 声部 ·{' '}
                {row.decoder === 'rosvot'
                  ? '词音节奏'
                  : row.decoder === 'acoustic'
                  ? '声学起止提案'
                  : row.decoder === 'legato'
                    ? '细节提案'
                    : row.proposal
                      ? '标准提案'
                      : '原始模型'}
                {row.uncertainRegions > 0 ? ` · ${row.uncertainRegions} 段待定` : ''}
              </small>
            </span>
            {opening === row.id ? <CircleNotch className="spin" size={17} /> : <ArrowRight size={16} />}
          </button>
        ))}
      </div>
      {!loading && !error && rows.length === 0 && <span className="subtle-note">尚无本地音频转谱记录。</span>}
    </section>
  );
}
