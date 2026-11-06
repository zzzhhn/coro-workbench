import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import Modal from './Modal';
import { cancelJob, getJob, rebuildVocal } from '../lib/api';
import { validateProject } from '../lib/music';
import { PENDING_VOCAL_REBUILD_KEY, readPendingVocalRebuild, vocalRebuildSourceId, type PendingVocalRebuild } from '../lib/vocalRebuild';
import type { AnalysisJob, ScoreProject } from '../lib/types';

export default function VocalRebuildDialog({ project, hasArrangement, onClose, onOpen, onBeforeStart }: {
  project: ScoreProject;
  hasArrangement: boolean;
  onClose: () => void;
  onOpen: (project: ScoreProject) => void;
  onBeforeStart: () => void;
}) {
  const [snapshot] = useState(() => structuredClone(project));
  const [pending, setPending] = useState<PendingVocalRebuild | undefined>(() => readPendingVocalRebuild(localStorage));
  const [job, setJob] = useState<AnalysisJob>();
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [cacheWarning, setCacheWarning] = useState('');
  const beforeNotes = pending?.beforeNotes ?? snapshot.parts.find((part) => part.id === 'vocals')?.notes.filter((note) => note.midi !== null).length ?? 0;
  const manualNotes = snapshot.parts.find((part) => part.id === 'vocals')?.notes.filter((note) => note.origin === 'manual' || note.lyric).length ?? 0;
  const running = Boolean(pending && (!job || ['queued', 'running'].includes(job.status)));
  const complete = job?.status === 'complete' && job.project;
  const busy = submitting || running;

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getJob(pending.jobId);
        if (!active) return;
        setJob(next);
        setError(next.status === 'error' ? next.error ?? next.message : '');
        if (['queued', 'running'].includes(next.status)) timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : '读取重建进度失败。';
        setError(message);
        if (/404|找不到.*任务|Not Found/i.test(message)) {
          setJob({ id: pending.jobId, status: 'error', progress: 0, stage: 'error', message });
        } else timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [pending?.jobId]);

  const clearPending = () => {
    try {
      if (pending && readPendingVocalRebuild(localStorage)?.jobId === pending.jobId)
        localStorage.removeItem(PENDING_VOCAL_REBUILD_KEY);
    } catch { /* The server still retains the completed result. */ }
    setPending(undefined);
  };
  const close = () => {
    if (submitting) return;
    if (!running) clearPending();
    onClose();
  };
  const begin = async () => {
    if (busy) return;
    setSubmitting(true);
    setError('');
    try {
      const errors = validateProject(snapshot);
      if (errors.length) throw new Error(errors.join('\n'));
      onBeforeStart();
      const created = await rebuildVocal(snapshot);
      const record = { jobId: created.id, sourceId: snapshot.id, title: snapshot.title, beforeNotes, hadArrangement: hasArrangement };
      setJob(created);
      setPending(record);
      try { localStorage.setItem(PENDING_VOCAL_REBUILD_KEY, JSON.stringify(record)); }
      catch { setCacheWarning('浏览器未允许任务缓存，请保持此页开启。完成的结果也会保存在工程库。'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法启动主唱重建。'); }
    finally { setSubmitting(false); }
  };
  const stop = async () => {
    if (!pending || cancelling) return;
    setCancelling(true);
    try { setJob(await cancelJob(pending.jobId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '取消失败，请重试。'); }
    finally { setCancelling(false); }
  };
  const open = () => {
    if (!complete) return;
    const errors = validateProject(complete);
    if (errors.length) { setError(errors.join('\n')); return; }
    clearPending();
    onOpen(complete);
  };

  return (
    <Modal title="重建主唱节奏" eyebrow="REBUILD VOCAL" onClose={close}>
      <p className="modal-description">{pending?.title ?? snapshot.title}</p>
      <div className="rebuild-scope">
        <strong>只重建主唱，不重跑分轨</strong>
        <p>复用本机已分离的主唱分析段，用词音边界与原声对齐重建节奏；未分析的尾部不会补转。其他乐器、和弦、调号、拍号和你的播放速度保持不变。</p>
        <p>结果另存一份，旧总谱{(pending?.hadArrangement ?? hasArrangement) ? '和已有阿卡贝拉编配' : ''}仍保留在工程库。不会把新主唱悄悄塞进旧编配。</p>
      </div>
      {!pending && (
        <p className="rebuild-caution"><WarningCircle size={17} />
          <span>新副本会替换主唱的全部音符和歌词，按原录音音高重建，不继承主唱的手工移调。
            {manualNotes > 0 ? ` 当前主唱有 ${manualNotes} 个手工编辑或带歌词的音符，这些保留在旧工程中。` : '原录音不会改动。'}
          </span>
        </p>
      )}
      {pending && (
        <section className="job-progress" aria-label="主唱重建进度">
          <div><strong>{complete ? '新副本已就绪' : job?.status === 'cancelled' ? '已取消，原谱不变' : job?.message ?? '正在读取任务进度…'}</strong><span>{job?.progress ?? 0}%</span></div>
          <progress max={100} value={job?.progress ?? 0} />
          {running && <p>关闭窗口不会取消任务。完成后可在工程库打开结果，也可再次点击「重建主唱节奏」查看。</p>}
        </section>
      )}
      {complete && (
        <div className="rebuild-result" role="status">
          <CheckCircle size={21} />
          <div><strong>主唱 {beforeNotes} → {complete.parts.find((part) => part.id === 'vocals')?.notes.filter((note) => note.midi !== null).length ?? 0} 个音符</strong>
            <p>原工程还未切换。打开新副本后，可对照原声试听，再生成新的阿卡贝拉编配。</p>
            <p>音符数变化不是准确率；已保留本次重建前的工程快照。</p>
          </div>
        </div>
      )}
      {cacheWarning && <p className="subtle-note">{cacheWarning}</p>}
      {error && <div className="error-message" role="alert"><WarningCircle size={18} />{error}</div>}
      <div className="modal-actions">
        <button className="secondary-button" disabled={submitting} onClick={close}>{running ? '后台继续' : complete ? '暂不切换' : '返回原谱'}</button>
        {running ? <button className="secondary-button" disabled={cancelling} onClick={() => void stop()}>{cancelling ? '正在取消…' : '取消重建'}</button>
          : complete ? <button className="primary-button" onClick={open}>打开新副本 <ArrowRight size={17} /></button>
            : <button className="primary-button" disabled={submitting || !vocalRebuildSourceId(snapshot)} onClick={() => void begin()}>{submitting ? <CircleNotch className="spin" size={17} /> : null}另存并重建主唱</button>}
      </div>
    </Modal>
  );
}
