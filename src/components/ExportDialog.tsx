import { useRef, useState } from 'react';
import {
  ArrowDown,
  Check,
  FileCode,
  FilePdf,
  FloppyDisk,
  MusicNotes,
  SpeakerHigh,
  WarningCircle,
  VideoCamera,
  Package,
} from '@phosphor-icons/react';
import Modal from './Modal';
import type { ScoreProject } from '../lib/types';
import { toAbc, toMidi, toMusicXml } from '../lib/music';
import { downloadFile, serializeProject } from '../lib/storage';
import { renderProjectAudio } from '../lib/audio';
import type { WorkspaceState } from '../lib/storage';
import { createProjectBundle } from '../lib/projectBundle';

const formats = [
  {
    id: 'musicxml',
    label: 'MusicXML',
    detail: '在 MuseScore / Dorico / Sibelius 中继续编辑',
    Icon: FileCode,
  },
  { id: 'midi', label: 'MIDI', detail: '多轨音符、速度与乐器程序', Icon: MusicNotes },
  { id: 'pdf', label: 'PDF 乐谱', detail: '本地生成分页矢量谱，内嵌中文字体', Icon: FilePdf },
  { id: 'wav', label: '排练音频 WAV', detail: '离线渲染选中声部，不含原音频', Icon: SpeakerHigh },
  {
    id: 'mp4',
    label: '排练视频 MP4',
    detail: '1080p 分段谱面 + 排练音轨，本机 H.264 编码',
    Icon: VideoCamera,
  },
  {
    id: 'bundle',
    label: '便携工程 .coro',
    detail: '原曲 + 编配 + 原音频一起打包，换电脑可继续编辑',
    Icon: Package,
  },
  { id: 'json', label: 'Coro 工程', detail: '完整保留编辑数据；原音频另行保存', Icon: FloppyDisk },
  { id: 'abc', label: 'ABC 乐谱源码', detail: '沿用 ChordHold 的可读记谱格式', Icon: FileCode },
];

export default function ExportDialog({
  project,
  workspace,
  onClose,
  onDone,
}: {
  project: ScoreProject;
  workspace?: WorkspaceState;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [format, setFormat] = useState('musicxml');
  const [partId, setPartId] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [includeStems, setIncludeStems] = useState(false);
  const videoJob = useRef<string | undefined>(undefined);
  const cancelled = useRef(false);
  const exportFile = async () => {
    setBusy(true);
    setError('');
    cancelled.current = false;
    setProgress('准备导出…');
    const name = project.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100) || 'Coro';
    const ids = partId === 'all' ? undefined : [partId];
    const suffix =
      partId === 'all' ? '' : `-${project.parts.find((part) => part.id === partId)?.shortName ?? 'part'}`;
    try {
      if (format === 'musicxml')
        downloadFile(
          toMusicXml(project, ids),
          `${name}${suffix}.musicxml`,
          'application/vnd.recordare.musicxml+xml',
        );
      else if (format === 'midi') downloadFile(toMidi(project, ids), `${name}${suffix}.mid`, 'audio/midi');
      else if (format === 'json')
        downloadFile(serializeProject(project), `${name}.coro.json`, 'application/json');
      else if (format === 'bundle') {
        const state = workspace ?? {
          source: project,
          active: 'source' as const,
          savedAt: new Date().toISOString(),
        };
        const archive = await createProjectBundle(state, includeStems, setProgress);
        downloadFile(archive, `${name}.coro`, 'application/zip');
      } else if (format === 'abc')
        downloadFile(toAbc(project, ids).abc, `${name}${suffix}.abc`, 'text/vnd.abc');
      else if (format === 'wav') {
        const rendered = await renderProjectAudio(project, ids);
        downloadFile(rendered.bytes, `${name}${suffix}-rehearsal.wav`, 'audio/wav');
      } else if (format === 'pdf') {
        const { renderScorePdf } = await import('../lib/pdf');
        downloadFile(await renderScorePdf(project, ids), `${name}${suffix}.pdf`, 'application/pdf');
      } else if (format === 'mp4') {
        const { createVideoPackage, startVideoExport, getVideoJob } = await import('../lib/video');
        const archive = await createVideoPackage(project, ids, setProgress);
        const created = await startVideoExport(archive);
        videoJob.current = created.id;
        let job = created;
        while (!['complete', 'error', 'cancelled'].includes(job.status)) {
          if (cancelled.current) throw new Error('视频导出已取消。');
          setProgress(`${job.message} ${Math.round(job.progress)}%`);
          await new Promise((resolve) => setTimeout(resolve, 700));
          job = await getVideoJob(created.id);
        }
        if (job.status !== 'complete' || !job.downloadUrl)
          throw new Error(job.error ?? job.message ?? '视频导出失败。');
        const response = await fetch(job.downloadUrl);
        if (!response.ok) throw new Error('MP4 已生成但无法读取，请重试下载。');
        downloadFile(await response.blob(), `${name}${suffix}-rehearsal.mp4`, 'video/mp4');
      }
      onDone('文件已导出。');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败，请重试。');
    } finally {
      setBusy(false);
      videoJob.current = undefined;
    }
  };
  return (
    <Modal
      title="导出乐谱与排练音频"
      eyebrow="EXPORT"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="export-formats" role="radiogroup" aria-label="导出格式">
        {formats.map(({ id, label, detail, Icon }) => (
          <button
            key={id}
            className={`export-format ${format === id ? 'selected' : ''}`}
            role="radio"
            aria-checked={format === id}
            onClick={() => setFormat(id)}
            disabled={busy}
          >
            <Icon size={23} />
            <div>
              <strong>{label}</strong>
              <span>{detail}</span>
            </div>
            {format === id && <Check size={19} />}
          </button>
        ))}
      </div>
      <label className="field-label">
        导出范围
        <select
          aria-label="导出声部"
          value={partId}
          disabled={busy || format === 'json' || format === 'bundle'}
          onChange={(event) => setPartId(event.target.value)}
        >
          <option value="all">完整总谱 · {project.parts.length} 个声部</option>
          {project.parts.map((part) => (
            <option key={part.id} value={part.id}>
              {part.name}
            </option>
          ))}
        </select>
      </label>
      {format === 'bundle' && (
        <label className="check-option">
          <input
            type="checkbox"
            checked={includeStems}
            onChange={(event) => setIncludeStems(event.target.checked)}
            disabled={busy}
          />
          同时打包分离音轨（文件会更大）
        </label>
      )}
      <p className="subtle-note">
        导出范围以此处为准，不受静音 / 独奏开关影响。
        {format === 'bundle'
          ? '便携工程包含当前原曲、编配与原始音频/谱页；未勾选的分离音轨和后端模型证据不包含。'
          : '普通 Coro JSON 工程不包含音频/谱页文件；需要一起带走时请选择便携工程。'}
        请保留原文件，并确认作品改编与演出授权。
      </p>
      {error && (
        <div className="error-message" role="alert">
          <WarningCircle size={19} />
          {error}
        </div>
      )}
      {busy && (
        <p className="export-progress" role="status">
          {progress}
        </p>
      )}
      {busy && videoJob.current && (
        <button
          className="text-button"
          onClick={async () => {
            cancelled.current = true;
            const { cancelVideoJob } = await import('../lib/video');
            try {
              await cancelVideoJob(videoJob.current!);
            } catch (error) {
              setError(error instanceof Error ? error.message : '取消失败');
            }
          }}
        >
          取消视频编码
        </button>
      )}
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button className="primary-button" onClick={() => void exportFile()} disabled={busy}>
          {busy ? '正在离线渲染…' : '导出文件'}
          <ArrowDown size={17} />
        </button>
      </div>
    </Modal>
  );
}
