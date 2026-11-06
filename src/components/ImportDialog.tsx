import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  FileAudio,
  FileText,
  Headphones,
  LockKey,
  UploadSimple,
  WarningCircle,
  Waveform,
} from '@phosphor-icons/react';
import Modal from './Modal';
import {
  analyzeAudio,
  cancelJob,
  getHealth,
  getJob,
  recognizeScore,
  getOmrJob,
  cancelOmrJob,
  type EngineHealth,
} from '../lib/api';
import { importScoreFile, projectFromOmr } from '../lib/import';
import type { AnalysisJob, OmrJob, ScoreProject } from '../lib/types';
import { importProjectBundle } from '../lib/projectBundle';
import type { WorkspaceState } from '../lib/storage';

interface Props {
  onClose: () => void;
  onImport: (project: ScoreProject) => void;
  onDemo: () => void;
  onWorkspace: (workspace: WorkspaceState) => void;
}
export const PENDING_ANALYSIS_KEY = 'coro.pending-analysis.v1';
const stageLabels: Record<string, string> = {
  queued: '等待分析',
  decoding: '读取音频',
  rhythm: '分析节拍',
  instruments: '判断音色候选',
  separating: '分离音轨',
  transcribing: '逐轨转谱',
  'voice-verification': '核对主唱音高',
  harmony: '从伴奏辨识和弦',
  'vocal-notes': '重建主唱词音节奏',
  multi: '联合识别乐器族群',
  score: '生成总谱',
  complete: '转谱完成',
};

export default function ImportDialog({ onClose, onImport, onDemo, onWorkspace }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<'quick' | 'separate' | 'multi'>('separate');
  const [quality, setQuality] = useState<'auto' | 'raw'>('auto');
  const [decoder, setDecoder] = useState<'standard' | 'legato' | 'acoustic' | 'rosvot'>('rosvot');
  const [verification, setVerification] = useState<'full' | 'sampled'>('full');
  const [tempo, setTempo] = useState('');
  const [maxSeconds, setMaxSeconds] = useState(90);
  const [health, setHealth] = useState<EngineHealth>();
  const [healthError, setHealthError] = useState(false);
  const [job, setJob] = useState<AnalysisJob | OmrJob>();
  const [firstPage, setFirstPage] = useState(1);
  const [lastPage, setLastPage] = useState('');
  const [readText, setReadText] = useState(false);
  const jobKind = useRef<'audio' | 'omr'>('audio');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeJob = useRef<string | undefined>(undefined);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const scoreFile = Boolean(file && /\.(musicxml|xml|mxl|mid|midi|json|coro)$/i.test(file.name));
  const imageScore = Boolean(file && /\.(pdf|png|jpe?g|tiff?|webp|bmp)$/i.test(file.name));
  useEffect(() => {
    mounted.current = true;
    void getHealth()
      .then((result) => {
        if (mounted.current) setHealth(result);
      })
      .catch(() => {
        if (mounted.current) setHealthError(true);
      });
    const pending = localStorage.getItem(PENDING_ANALYSIS_KEY);
    if (pending && /^(?:omr:)?[a-f0-9]{32}$/.test(pending)) {
      jobKind.current = pending.startsWith('omr:') ? 'omr' : 'audio';
      const id = pending.replace(/^omr:/, '');
      activeJob.current = id;
      setBusy(true);
      setJob({
        id,
        status: 'queued',
        progress: 0,
        stage: '恢复任务',
        message: '正在读取本地引擎中尚未接收的分析结果。',
      });
      void poll(id);
    }
    return () => {
      mounted.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);
  const choose = (selected?: File) => {
    if (!selected) return;
    setError('');
    const fileLimit = /\.coro$/i.test(selected.name)
      ? 300
      : /\.(pdf|png|jpe?g|tiff?|webp|bmp)$/i.test(selected.name)
        ? 50
        : 100;
    if (selected.size > fileLimit * 1024 * 1024) {
      setError(`文件超过 ${fileLimit} MB。请裁剪或压缩后再导入。`);
      return;
    }
    if (
      !/\.(wav|mp3|flac|m4a|ogg|opus|aac|aiff?|mp4|musicxml|xml|mxl|mid|midi|json|coro|pdf|png|jpe?g|tiff?|webp|bmp)$/i.test(
        selected.name,
      )
    ) {
      setError('不支持此文件类型。支持音频、PDF/图片谱、MIDI、MusicXML 与 Coro 工程。');
      return;
    }
    setFile(selected);
    setJob(undefined);
  };
  const poll = async (id: string) => {
    try {
      const current = jobKind.current === 'omr' ? await getOmrJob(id) : await getJob(id);
      if (!mounted.current || activeJob.current !== id) return;
      setJob(current);
      if (current.status === 'complete') {
        localStorage.removeItem(PENDING_ANALYSIS_KEY);
        activeJob.current = undefined;
        setBusy(false);
        if ('musicxml' in current && current.musicxml) {
          onImport(projectFromOmr(current));
        } else if ('project' in current && current.project) onImport(current.project);
        else throw new Error('任务未返回可读取的乐谱。');
      } else if (current.status === 'error' || current.status === 'cancelled') {
        localStorage.removeItem(PENDING_ANALYSIS_KEY);
        activeJob.current = undefined;
        setBusy(false);
        setError(current.error ?? current.message ?? '分析已停止。');
      } else pollTimer.current = setTimeout(() => void poll(id), 1300);
    } catch (cause) {
      if (!mounted.current) return;
      const message = cause instanceof Error ? cause.message : '读取分析进度失败。';
      setError(message);
      if (/找不到.*任务|404|Not Found/i.test(message)) {
        localStorage.removeItem(PENDING_ANALYSIS_KEY);
        activeJob.current = undefined;
        setBusy(false);
        return;
      }
      pollTimer.current = setTimeout(() => void poll(id), 3500);
    }
  };
  const begin = async () => {
    if (!file || busy) return;
    setError('');
    setBusy(true);
    try {
      if (scoreFile) {
        if (/\.coro$/i.test(file.name)) {
          onWorkspace(await importProjectBundle(file));
          return;
        }
        onImport(await importScoreFile(file));
        return;
      }
      if (tempo && (Number(tempo) < 30 || Number(tempo) > 240))
        throw new Error('速度提示需在 30 至 240 BPM 之间。');
      jobKind.current = imageScore ? 'omr' : 'audio';
      if (
        imageScore &&
        (firstPage < 1 ||
          (lastPage && (Number(lastPage) < firstPage || Number(lastPage) - firstPage + 1 > 12)))
      )
        throw new Error('请选择有效页码，每次最多识别 12 页。');
      const created = imageScore
        ? await recognizeScore(file, {
            firstPage,
            lastPage: lastPage ? Number(lastPage) : undefined,
            readText,
          })
        : await analyzeAudio(file, {
            mode,
            tempo: tempo ? Number(tempo) : undefined,
            maxSeconds,
            quality,
            decoder,
            verification,
          });
      activeJob.current = created.id;
      try {
        localStorage.setItem(PENDING_ANALYSIS_KEY, `${imageScore ? 'omr:' : ''}${created.id}`);
      } catch {
        setError('浏览器未允许任务缓存，请勿刷新；本次分析仍在进行。');
      }
      setJob(created);
      void poll(created.id);
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : '导入失败，请重试。');
    }
  };
  const stop = async () => {
    if (!activeJob.current) return;
    try {
      const result =
        jobKind.current === 'omr'
          ? await cancelOmrJob(activeJob.current)
          : await cancelJob(activeJob.current);
      localStorage.removeItem(PENDING_ANALYSIS_KEY);
      activeJob.current = undefined;
      setJob(result);
      setBusy(false);
      setError('已取消。当前乐谱未被修改；原始文件仍保留在本机 data 目录。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消失败，请重试。');
    }
  };
  const ready = (key: string) => {
    const engine = health?.engines[key];
    return typeof engine === 'boolean' ? engine : (engine?.ready ?? engine?.available ?? false);
  };
  const sourceReady =
    ready('ffmpeg') &&
    (mode === 'multi' ? ready('yourMT3') : ready('basicPitch') && (mode !== 'separate' || ready('demucs')));

  return (
    <Modal title="导入音频或乐谱" eyebrow="IMPORT" onClose={onClose} wide>
      <p className="modal-description">
        上传你拥有使用权的音乐，或直接导入已有的乐谱。所有音频分析都在这台电脑完成。
      </p>
      <input
        ref={input}
        type="file"
        hidden
        aria-label="选择音乐文件"
        accept="audio/*,.mp4,.mid,.midi,.musicxml,.xml,.mxl,.json,.coro,.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp,.bmp"
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <button
        className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!busy) choose(event.dataTransfer.files[0]);
        }}
      >
        <div className="upload-symbol">
          {file ? (
            scoreFile || imageScore ? (
              <FileText size={29} />
            ) : (
              <FileAudio size={29} />
            )
          ) : (
            <UploadSimple size={29} />
          )}
        </div>
        <strong>{file ? file.name : '把音乐拖到这里，或点击选择'}</strong>
        <span>
          {file
            ? `${(file.size / 1024 / 1024).toFixed(2)} MB · 点击更换文件`
            : '音频 · PDF / PNG / JPEG 谱页 · MIDI / MusicXML · Coro 工程'}
        </span>
        {!file && <small>音频 ≤ 100 MB；PDF/图片 ≤ 50 MB、每次 ≤ 12 页；工程包 ≤ 300 MB</small>}
      </button>
      {!scoreFile && !imageScore && (
        <>
          <div className="mode-options" role="radiogroup" aria-label="转谱方式">
            <button
              className={`mode-option ${mode === 'separate' ? 'selected' : ''}`}
              role="radio"
              aria-checked={mode === 'separate'}
              onClick={() => setMode('separate')}
              disabled={busy}
            >
              <Headphones size={21} />
              <div>
                <strong>
                  分轨转谱 <span>推荐</span>
                </strong>
                <p>分离人声、鼓、低音、钢琴、吉他与其余，再逐轨识别音高。适合歌曲。</p>
              </div>
              <i>{mode === 'separate' && <Check size={13} weight="bold" />}</i>
            </button>
            <button
              className={`mode-option ${mode === 'quick' ? 'selected' : ''}`}
              role="radio"
              aria-checked={mode === 'quick'}
              onClick={() => setMode('quick')}
              disabled={busy}
            >
              <Waveform size={21} />
              <div>
                <strong>直接转谱</strong>
                <p>直接识别音符，不分乐器。适合清晰的独奏、哼唱和单轨素材。</p>
              </div>
              <i>{mode === 'quick' && <Check size={13} weight="bold" />}</i>
            </button>
            <button
              className={`mode-option multi-option ${mode === 'multi' ? 'selected' : ''}`}
              role="radio"
              aria-checked={mode === 'multi'}
              onClick={() => setMode('multi')}
              disabled={busy}
            >
              <FileText size={21} />
              <div>
                <strong>
                  多乐器族群识谱 <span>实验</span>
                </strong>
                <p>
                  YourMT3+
                  直接识别弦乐、管乐、键盘等族群及鼓的音符。更适合多乐器段落，但可能漏音、八度误判；不生成分离音轨，不区分同族每件乐器。
                </p>
              </div>
              <i>{mode === 'multi' && <Check size={13} weight="bold" />}</i>
            </button>
          </div>
          <div className="import-settings">
            <label>
              分析长度
              <select
                value={maxSeconds}
                onChange={(event) => setMaxSeconds(Number(event.target.value))}
                disabled={busy}
              >
                <option value={30}>前 30 秒 · 快速试用</option>
                <option value={90}>前 90 秒 · 默认</option>
                <option value={180}>前 3 分钟</option>
                <option value={300}>前 5 分钟</option>
              </select>
            </label>
            <label>
              速度提示 <span>可选</span>
              <input
                type="number"
                min={30}
                max={240}
                placeholder="自动估计 BPM"
                value={tempo}
                onChange={(event) => setTempo(event.target.value)}
                disabled={busy}
              />
            </label>
          </div>
          <p className="subtle-note">
            原音频完整保留。首轮先按恒定速度、4/4
            拍量化，可在谱面校正。密集管弦乐、混响和鼓的音色无法保证逐一还原；结果是待校对草稿，不是原版总谱。
          </p>
          <label className="field-label">
            转写版本
            <select
              aria-label="转写整理版本"
              value={quality}
              onChange={(event) => setQuality(event.target.value as 'auto' | 'raw')}
              disabled={busy}
            >
              <option value="auto">生成节拍 / 主旋律 / 钢琴整理提案（保留原始结果）</option>
              <option value="raw">仅保留原始模型转写，不做整理</option>
            </select>
          </label>
          {quality === 'auto' && mode === 'separate' && (
            <>
              <label className="field-label">
                主唱分段
                <select
                  aria-label="主唱分段策略"
                  value={decoder}
                  onChange={(event) => setDecoder(event.target.value as 'standard' | 'legato' | 'acoustic' | 'rosvot')}
                  disabled={busy}
                >
                  <option value="rosvot">词音节奏 · 排练优先：学习演唱边界，再联合整理记谱节奏</option>
                  <option value="standard">基础分段：较少音符，保留作对照</option>
                  <option value="legato">细节提案：时长约束分段，保留更多旋律变化</option>
                  <option value="acoustic">声学起止对照：保留更多音高变化，可能产生碎音</option>
                </select>
                <small>
                  {decoder === 'rosvot'
                    ? '本机 ROSVOT/RWBD 辨识词音，再按原声对齐起止；保留重复吐字和原始候选，不生成歌词。'
                    : decoder === 'acoustic'
                    ? '在人审清唱留出集改善了音符起止；复杂混音仍需校对，不补缺失音高。'
                    : '细节提案可能增加短音符，需与标准版本对照；不是已确认更准确。'}
                </small>
              </label>
              <label className="field-label">
                独立音高校验
                <select
                  aria-label="主唱独立校验范围"
                  value={verification}
                  onChange={(event) => setVerification(event.target.value as 'full' | 'sampled')}
                  disabled={busy}
                >
                  <option value="full">完整核对所选分析段 · 较慢，标记模型分歧</option>
                  <option value="sampled">仅抽样核对 · 较快，未抽样部分未验证</option>
                </select>
                <small>用另一模型核对分离后的主唱音高，不改写音符；模型一致不等于谱面准确。</small>
              </label>
            </>
          )}
          <p className="subtle-note">
            整理采用独立节拍模型与声部专用模型。人声模型冲突时会弃权，不保证主唱识别成功；电子键盘或厚重多重人声可再与多乐器模式比较。
          </p>
          <div className={`engine-status ${sourceReady ? 'ready' : ''}`}>
            <span className="status-dot" />
            {healthError
              ? '本地引擎未连接。请在项目目录执行 npm start；乐谱导入仍可用。'
              : !health
                ? '检查本地音频引擎…'
                : sourceReady
                  ? mode === 'multi'
                    ? '本地 YourMT3+ 就绪 · 实验模型 · 仅在本机运行'
                    : `本地引擎就绪 · Basic Pitch${mode === 'separate' ? ' + Demucs' : ''}${quality === 'auto' && ready('quality') ? ' + 主唱 / 拍点整理' : ''}`
                  : mode === 'multi'
                    ? '实验引擎未安装，请运行 scripts/setup-yourmt3.sh（先阅读许可说明）。'
                    : '模型尚未就绪，请先运行 scripts/setup-audio.sh。'}
          </div>
        </>
      )}
      {imageScore && (
        <section className="omr-options">
          <div className="import-note">
            <FileText size={22} />
            <p>
              使用本机 Audiveris 识别印刷五线谱，转为可编辑、可播放的
              MusicXML。扫描件、手写谱、模糊照片和复杂连线可能出错；结果需对照原谱校正。
            </p>
          </div>
          <div className="import-settings">
            <label>
              起始页
              <input
                type="number"
                aria-label="识谱起始页"
                min={1}
                max={200}
                value={firstPage}
                onChange={(event) => setFirstPage(Number(event.target.value))}
                disabled={busy}
              />
            </label>
            <label>
              结束页（可选）
              <input
                type="number"
                aria-label="识谱结束页"
                min={firstPage}
                max={Math.min(200, firstPage + 11)}
                value={lastPage}
                placeholder="全部，最多 12 页"
                onChange={(event) => setLastPage(event.target.value)}
                disabled={busy}
              />
            </label>
          </div>
          <label className="check-option">
            <input
              type="checkbox"
              checked={readText}
              onChange={(event) => setReadText(event.target.checked)}
              disabled={busy}
            />
            尝试文字 / 歌词 OCR（实验）
          </label>
          <p className="subtle-note">
            默认关闭文字 OCR，避免中文标题和歌词误读造成声部串接；识别后保留原谱页供核对。PDF 若超过 12
            页，请指定页码区间。
          </p>
          <div className={`engine-status ${ready('omr') ? 'ready' : ''}`}>
            <span className="status-dot" />
            {ready('omr')
              ? 'Audiveris 本地光学识谱已就绪'
              : healthError
                ? '本地引擎未连接，请运行 npm start。'
                : '本地 OMR 未就绪，请运行 scripts/setup-omr.sh。'}
          </div>
        </section>
      )}
      {scoreFile && (
        <div className="import-note">
          <FileText size={22} />
          <p>
            保留可支持的声部、音高、时值、歌词和演奏记号。变速、变拍及复杂排版会明确提示，不会悄悄宣称完整还原。
          </p>
        </div>
      )}
      {job && busy && (
        <div className="job-progress" aria-live="polite">
          <div>
            <strong>{stageLabels[job.stage] ?? job.stage ?? '准备分析'}</strong>
            <span>{Math.round(job.progress)}%</span>
          </div>
          <progress value={job.progress} max={100} />
          <p>{job.message || '实际模型正在处理音频，请保持工作台开启。'}</p>
          <button className="text-button" onClick={() => void stop()}>
            取消分析
          </button>
        </div>
      )}
      {error && (
        <div className="error-message" role="alert">
          <WarningCircle size={19} />
          <span>{error}</span>
        </div>
      )}
      <div className="modal-actions">
        <button className="text-button" onClick={onDemo} disabled={busy}>
          先体验原创示例
        </button>
        <button
          className="primary-button"
          onClick={() => void begin()}
          disabled={!file || busy || (imageScore ? !ready('omr') : !scoreFile && !sourceReady)}
        >
          {busy
            ? imageScore
              ? '正在识谱…'
              : '正在分析…'
            : scoreFile
              ? '导入乐谱'
              : imageScore
                ? '识别并生成乐谱'
                : '开始转谱'}
          {!busy && <ArrowRight size={18} />}
        </button>
      </div>
      <div className="privacy-line">
        <LockKey size={14} />
        <span>本地处理 · 无需账号 · 不上传音频 · 不训练模型</span>
      </div>
    </Modal>
  );
}
