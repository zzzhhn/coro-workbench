import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  CircleNotch,
  Copy,
  DotsThree,
  FilePlus,
  FolderOpen,
  Headphones,
  Info,
  Keyboard,
  List,
  LockKey,
  MicrophoneStage,
  Minus,
  MusicNotes,
  NotePencil,
  PianoKeys,
  Plus,
  SlidersHorizontal,
  Sparkle,
  UploadSimple,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import type { ArrangementOptions, NoteEvent, ScorePart, ScoreProject } from './lib/types';
import type { Selection } from './lib/editor';
import { beatsPerBar, pitchName, toMusicXml, fromMusicXml } from './lib/music';
import { scoreWindow } from './lib/scoreWindow';
import { arrangeForVoices } from './lib/arrange';
import { createBlankProject, createDemoProject } from './lib/demo';
import {
  changePart,
  deleteNote,
  duplicateMeasure,
  editId,
  insertNote,
  modifyNote,
  transposeProject,
} from './lib/editor';
import {
  PlaybackEngine,
  readWaveform,
  renderProjectAudio,
  sourceBeatLength,
  waveformPeaks,
  type PlaybackMode,
  type PlaybackState,
} from './lib/audio';
import {
  downloadFile,
  getLocalAudio,
  readWorkspace,
  saveLocalAudio,
  saveWorkspace,
  serializeProject,
  registerLocalAssetUrl,
  type WorkspaceState,
} from './lib/storage';
import { getHealth } from './lib/api';
import ScoreView from './components/ScoreView';
import Inspector, { durationGlyphs, durationOptions } from './components/Inspector';
import EnsemblePanel from './components/EnsemblePanel';
import PracticePanel from './components/PracticePanel';
import SourceReference from './components/SourceReference';
import TransportBar from './components/TransportBar';
import SourceEvidence from './components/SourceEvidence';
import RepairDialog from './components/RepairDialog';
import LibraryDialog from './components/LibraryDialog';
import { archiveWorkspace } from './lib/library';
import { notationReadabilitySummary } from './lib/readability';
import { recommendLeadPart } from './lib/arrange';
import ImportDialog, { PENDING_ANALYSIS_KEY } from './components/ImportDialog';
import ArrangeDialog from './components/ArrangeDialog';
import ExportDialog from './components/ExportDialog';
import Modal from './components/Modal';
import { readOriginalFile, resolveLocalAsset } from './lib/projectBundle';
import PitchReviewDialog from './components/PitchReviewDialog';
import VocalRebuildDialog from './components/VocalRebuildDialog';
import { readPendingVocalRebuild, vocalRebuildSourceId } from './lib/vocalRebuild';

type ActiveDocument = 'source' | 'arrangement';
type Dialog =
  | 'import'
  | 'arrange'
  | 'export'
  | 'help'
  | 'project'
  | 'library'
  | 'source'
  | 'delete-part'
  | 'repair'
  | 'pitch-review'
  | 'vocal-rebuild'
  | undefined;
type History = { past: ScoreProject[]; future: ScoreProject[] };
const newHistory = (): Record<ActiveDocument, History> => ({
  source: { past: [], future: [] },
  arrangement: { past: [], future: [] },
});
const cleanError = (error: unknown) => (error instanceof Error ? error.message : '操作未完成，请重试。');
const scoreDuration = (project: ScoreProject) =>
  (project.measures * beatsPerBar(project) * 60) / project.tempo;

export default function App() {
  const initial = useMemo(() => readWorkspace(), []);
  const [source, setSource] = useState<ScoreProject>(initial?.source ?? createDemoProject());
  const [arrangement, setArrangement] = useState<ScoreProject | undefined>(initial?.arrangement);
  const [active, setActive] = useState<ActiveDocument>(
    initial?.active === 'arrangement' && initial?.arrangement ? 'arrangement' : 'source',
  );
  const project = active === 'arrangement' && arrangement ? arrangement : source;
  const [selectedPartId, setSelectedPartId] = useState(project.parts[0].id);
  const [selection, setSelection] = useState<Selection>();
  const [visiblePart, setVisiblePart] = useState('all');
  const [dialog, setDialog] = useState<Dialog>(() =>
    readPendingVocalRebuild(localStorage) ? 'vocal-rebuild' : localStorage.getItem(PENDING_ANALYSIS_KEY) ? 'import' : undefined,
  );
  const [mobilePanel, setMobilePanel] = useState<'parts' | 'inspector' | undefined>();
  const [panelPreference, setPanelPreference] = useState<{ parts?: boolean; inspector?: boolean }>({});
  const [tab, setTab] = useState<'workbench' | 'practice'>('workbench');
  const [practicePartId, setPracticePartId] = useState('all');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [repairEntry, setRepairEntry] = useState<'staff' | 'beat'>('staff');
  const [pitchReviewSeconds, setPitchReviewSeconds] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<'note' | 'check'>('note');
  const [toast, setToast] = useState<{ text: string; error: boolean }>();
  const [saved, setSaved] = useState<'saved' | 'saving' | 'error'>('saved');
  const [audioBusy, setAudioBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [playingState, setPlayingState] = useState<PlaybackState>({
    playing: false,
    beat: 0,
    mode: 'score',
    peak: 0,
  });
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('score');
  const [stem, setStem] = useState<{ url: string; name: string }>();
  const [peaks, setPeaks] = useState<number[]>([]);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(1);
  const [loopEnd, setLoopEnd] = useState(Math.min(4, project.measures));
  const [zoom, setZoom] = useState(100);
  const [pageSize, setPageSize] = useState<4 | 8 | 'all'>(4);
  const [barDraft, setBarDraft] = useState<string>();
  const [printing, setPrinting] = useState(false);
  const [showConfidence, setShowConfidence] = useState(true);
  const [entryDuration, setEntryDuration] = useState(1);
  const [stepEntry, setStepEntry] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const [engineReady, setEngineReady] = useState<boolean | undefined>();
  const [xmlDraft, setXmlDraft] = useState('');
  const [xmlError, setXmlError] = useState('');
  const [chordEdit, setChordEdit] = useState<number>();
  const [chordDraft, setChordDraft] = useState('');
  const engine = useRef<PlaybackEngine | null>(null);
  const history = useRef(newHistory());
  const workspaceRef = useRef({ source, arrangement, active });
  workspaceRef.current = { source, arrangement, active };
  const generatedDemo = useRef<string | undefined>(undefined);
  const localAudioUrls = useRef<Map<string, string>>(new Map());
  const switchingWorkspace = useRef(false);
  const pendingAssetSignature = [source, arrangement]
    .filter((item): item is ScoreProject => Boolean(item))
    .flatMap((item) => [...item.parts.map((part) => part.stemUrl), ...(item.source.pages ?? [])])
    .filter((url) => url?.startsWith('local:'))
    .join('|');
  const part =
    project.parts.find((part) => part.id === (selection?.partId ?? selectedPartId)) ?? project.parts[0];
  const selectedNote = part.notes.find((note) => note.id === selection?.noteId);
  const barLength = beatsPerBar(project);
  const totalBeats = project.measures * barLength;
  const currentBar = Math.max(1, Math.min(project.measures, Math.floor(playingState.beat / barLength) + 1));
  const measureRange = pageSize === 'all' ? undefined : scoreWindow(project.measures, currentBar, pageSize);
  const visibleChords = project.chords.flatMap((chord, index) => {
    const bar = Math.floor(chord.start / barLength) + 1;
    return !measureRange || (bar >= measureRange.start && bar <= measureRange.end) ? [{ chord, index, bar }] : [];
  });
  const denseScore = project.parts.length >= 8 || project.measures > 24;
  const partsOpen = panelPreference.parts ?? !denseScore;
  const inspectorOpen = panelPreference.inspector ?? (!denseScore || Boolean(selection));
  const sourceTempo = project.originalAudio?.tempo ?? project.tempo;
  const sourceLength = project.originalAudio?.duration ?? scoreDuration(project);
  const readabilityKey = useMemo(() => project.source.kind === 'audio' && project.tempo < 90 ? JSON.stringify({ tempo: project.tempo, meter: project.timeSignature, key: project.key, measures: project.measures, audioTempo: project.originalAudio?.tempo, audioOffset: project.originalAudio?.offsetSeconds, parts: project.parts.map(item => ({ id: item.id, role: item.role, roleSource: item.roleSource, notes: item.notes, staves: item.staves, clef: item.clef })) }) : '', [project]);
  const readableHint = useMemo(
    () =>
      project.source.kind === 'audio' && project.tempo < 90
        ? notationReadabilitySummary(project, [recommendLeadPart(project)?.id ?? project.parts[0].id])
        : undefined,
    [readabilityKey],
  );
  const sourceFraction = Math.max(
    0,
    Math.min(
      1,
      ((playingState.beat * 60) / sourceTempo + (project.originalAudio?.offsetSeconds ?? 0)) / sourceLength,
    ),
  );

  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), toast.error ? 9000 : 3800);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const player = new PlaybackEngine();
    engine.current = player;
    player.subscribe(setPlayingState);
    return () => {
      player.dispose();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    const beforePrint = () => flushSync(() => setPrinting(true));
    const afterPrint = () => setPrinting(false);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    return () => {
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
    };
  }, []);
  useEffect(() => {
    let live = true;
    const check = () =>
      void getHealth()
        .then((health) => {
          if (live) setEngineReady(health.status === 'ok');
        })
        .catch(() => {
          if (live) setEngineReady(false);
        });
    check();
    const timer = setInterval(check, 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    setSaved('saving');
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const state = { source, arrangement, active, savedAt: new Date().toISOString() };
        saveWorkspace(state);
        await archiveWorkspace(state);
        if (!cancelled) setSaved('saved');
      } catch {
        if (!cancelled) setSaved('error');
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source, arrangement, active]);
  useEffect(() => {
    const flush = () => {
      try { saveWorkspace({ ...workspaceRef.current, savedAt: new Date().toISOString() }); }
      catch { setSaved('error'); }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);
  useEffect(() => {
    engine.current?.updateMixer(project.parts);
  }, [project.parts]);
  useEffect(() => {
    engine.current?.setMetronome(metronome);
  }, [metronome]);
  useEffect(() => {
    if (practicePartId !== 'all' && !project.parts.some((item) => item.id === practicePartId))
      setPracticePartId('all');
  }, [project.parts, practicePartId]);
  useEffect(() => {
    const url = project.originalAudio?.url;
    if (!url || url.startsWith('local:')) {
      setPeaks([]);
      return;
    }
    let live = true;
    void readWaveform(url)
      .then((values) => {
        if (live) setPeaks(values);
      })
      .catch(() => {
        if (live) setPeaks([]);
      });
    return () => {
      live = false;
    };
  }, [project.originalAudio?.url]);
  useEffect(() => {
    const audio = source.originalAudio;
    if (audio?.url.startsWith('local:')) {
      const id = audio.url.slice(6);
      void getLocalAudio(id)
        .then((blob) => {
          if (!blob) {
            notify('原音频缓存不在此浏览器中。工程乐谱仍可使用，请重新导入原音频。', true);
            return;
          }
          const url = localAudioUrls.current.get(id) ?? URL.createObjectURL(blob);
          localAudioUrls.current.set(id, url);
          registerLocalAssetUrl(url, id);
          setSource((previous) =>
            previous.id === source.id && previous.originalAudio
              ? { ...previous, originalAudio: { ...previous.originalAudio, url } }
              : previous,
          );
          setArrangement((previous) =>
            previous?.originalAudio?.url.startsWith('local:')
              ? { ...previous, originalAudio: { ...previous.originalAudio, url } }
              : previous,
          );
        })
        .catch(() => notify('无法恢复本地音频缓存；乐谱不受影响。', true));
    }
  }, [source.id, source.originalAudio?.url, notify]);
  useEffect(() => {
    const projects = [source, arrangement].filter((item): item is ScoreProject => Boolean(item));
    const urls = [
      ...new Set(
        projects
          .flatMap((item) => [...item.parts.map((part) => part.stemUrl), ...(item.source.pages ?? [])])
          .filter((url): url is string => Boolean(url?.startsWith('local:'))),
      ),
    ];
    if (!urls.length) return;
    let live = true;
    void Promise.all(urls.map(async (url) => [url, await resolveLocalAsset(url)] as const))
      .then((entries) => {
        if (!live) {
          entries.forEach(([, url]) => URL.revokeObjectURL(url));
          return;
        }
        const map = new Map(entries);
        const resolve = (project: ScoreProject): ScoreProject => ({
          ...project,
          parts: project.parts.map((part) =>
            part.stemUrl && map.has(part.stemUrl) ? { ...part, stemUrl: map.get(part.stemUrl) } : part,
          ),
          source: { ...project.source, pages: project.source.pages?.map((url) => map.get(url) ?? url) },
        });
        setSource((previous) => resolve(previous));
        setArrangement((previous) => (previous ? resolve(previous) : previous));
      })
      .catch((error) => notify(error instanceof Error ? error.message : '本地素材恢复失败', true));
    return () => {
      live = false;
    };
  }, [source.id, arrangement?.id, pendingAssetSignature]);
  useEffect(() => {
    if (source.source.kind !== 'demo' || source.originalAudio || generatedDemo.current === source.id) return;
    generatedDemo.current = source.id;
    setDemoBusy(true);
    const original = createDemoProject();
    void renderProjectAudio(original)
      .then(async (rendered) => {
        const blob = new Blob([Uint8Array.from(rendered.bytes)], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        localAudioUrls.current.set(source.id, url);
        const audio = {
          name: 'Blue Hour · 原创合成示例.wav',
          url,
          duration: rendered.buffer.duration,
          offsetSeconds: 0,
          tempo: original.tempo,
        };
        try {
          await saveLocalAudio(source.id, blob);
        } catch {
          notify('示例音频已生成，但浏览器未允许离线缓存。', true);
        }
        setSource((previous) =>
          previous.id === source.id ? { ...previous, originalAudio: audio } : previous,
        );
        setArrangement((previous) =>
          previous && previous.source.kind === 'demo' ? { ...previous, originalAudio: audio } : previous,
        );
        setPeaks(waveformPeaks(rendered.buffer));
      })
      .catch((error) => {
        generatedDemo.current = undefined;
        notify(`示例音频生成失败：${cleanError(error)}`, true);
      })
      .finally(() => setDemoBusy(false));
  }, [source.id, source.source.kind, source.originalAudio, notify]);

  const updateProject = useCallback((next: ScoreProject, record = true, stop = true) => {
    const current =
      workspaceRef.current.active === 'arrangement'
        ? (workspaceRef.current.arrangement ?? workspaceRef.current.source)
        : workspaceRef.current.source;
    if (next === current) return;
    if (record) {
      const stack = history.current[workspaceRef.current.active];
      stack.past.push(current);
      if (stack.past.length > 60) stack.past.shift();
      stack.future = [];
      setHistoryVersion((value) => value + 1);
    }
    if (stop) engine.current?.pause();
    if (workspaceRef.current.active === 'arrangement') setArrangement(next);
    else setSource(next);
  }, []);
  const resetEditor = (next: ScoreProject) => {
    engine.current?.seek(0);
    setBarDraft(undefined);
    setSelectedPartId(next.parts[0].id);
    setSelection(undefined);
    setVisiblePart('all');
    setPracticePartId('all');
    setLoop(false);
    setLoopStart(1);
    setLoopEnd(Math.min(4, next.measures));
    setStem(undefined);
    setPlaybackMode('score');
    setMobilePanel(undefined);
  };
  const stash = async () => {
    try {
      const snapshot = workspaceRef.current;
      await archiveWorkspace({ ...snapshot, savedAt: new Date().toISOString() });
      if (workspaceRef.current.source !== snapshot.source || workspaceRef.current.arrangement !== snapshot.arrangement) {
        notify('保存期间工程有新修改，请再试一次切换。', true);
        return false;
      }
      return true;
    } catch {
      notify('未能保存当前工程，已取消切换。请先导出备份并检查浏览器存储空间或权限。', true);
      return false;
    }
  };
  const importProject = async (next: ScoreProject) => {
    if (switchingWorkspace.current) return false;
    switchingWorkspace.current = true;
    try {
    if (!await stash()) return false;
    setSource(next);
    setArrangement(undefined);
    setActive('source');
    history.current = newHistory();
    setHistoryVersion((value) => value + 1);
    resetEditor(next);
    setDialog(undefined);
    notify(`已导入「${next.title}」`);
    return true;
    } finally { switchingWorkspace.current = false; }
  };
  const openWorkspace = async (next: WorkspaceState) => {
    if (switchingWorkspace.current) return false;
    switchingWorkspace.current = true;
    try {
    if (!await stash()) return false;
    setSource(next.source);
    setArrangement(next.arrangement);
    setActive(next.active);
    history.current = newHistory();
    setHistoryVersion((value) => value + 1);
    resetEditor(next.active === 'arrangement' && next.arrangement ? next.arrangement : next.source);
    setDialog(undefined);
    return true;
    } finally { switchingWorkspace.current = false; }
  };
  const switchDocument = (next: ActiveDocument) => {
    if (next === 'arrangement' && !arrangement) {
      setDialog('arrange');
      return;
    }
    if (next === active) return;
    setActive(next);
    resetEditor(next === 'source' ? source : arrangement!);
  };
  const arrange = (options: ArrangementOptions) => {
    try {
      engine.current?.pause();
      const next = arrangeForVoices(source, options);
      if (arrangement) {
        history.current.arrangement.past.push(arrangement);
        history.current.arrangement.future = [];
      }
      setArrangement(next);
      setActive('arrangement');
      resetEditor(next);
      setDialog(undefined);
      notify('阿卡贝拉编配已生成。原总谱已保留，请先试听并校对。');
    } catch (error) {
      notify(cleanError(error), true);
    }
  };
  const undo = () => {
    const stack = history.current[active];
    const previous = stack.past.pop();
    if (!previous) return;
    stack.future.push(project);
    updateProject(previous, false);
    setSelection(undefined);
    setHistoryVersion((value) => value + 1);
  };
  const redo = () => {
    const stack = history.current[active];
    const next = stack.future.pop();
    if (!next) return;
    stack.past.push(project);
    updateProject(next, false);
    setSelection(undefined);
    setHistoryVersion((value) => value + 1);
  };
  const selectNote = (next: Selection, beat?: number) => {
    const note = project.parts
      .find((part) => part.id === next.partId)
      ?.notes.find((note) => note.id === next.noteId);
    if (tab === 'practice') {
      if (note) seekBeat(beat ?? note.start);
      return;
    }
    setSelection(next);
    setSelectedPartId(next.partId);
    setInspectorTab('note');
    if (window.innerWidth <= 1120) setMobilePanel('inspector');
    if (note && !playingState.playing) engine.current?.seek(beat ?? note.start);
  };
  const changeNote = (patch: Partial<NoteEvent>) => {
    if (!selection) return;
    try {
      const next = modifyNote(project, selection, patch);
      updateProject(next);
      if (patch.start !== undefined) {
        const moved = next.parts.find((item) => item.id === selection.partId)?.notes
          .find((note) => note.id === selection.noteId);
        if (moved) engine.current?.seek(moved.start);
      }
      if (patch.midi !== undefined && patch.midi !== null)
        void engine.current?.audition(part, patch.midi).catch((error) => notify(cleanError(error), true));
    } catch (error) {
      notify(cleanError(error), true);
    }
  };
  const removeNote = () => {
    if (selection) {
      updateProject(deleteNote(project, selection));
      setSelection(undefined);
    }
  };
  const addNote = (midi: number | null = part.clef === 'bass' ? 48 : 60) => {
    const start =
      stepEntry && selectedNote
        ? selectedNote.start + selectedNote.duration
        : Math.round(playingState.beat * 4) / 4;
    try {
      const result = insertNote(project, part.id, start, entryDuration, midi);
      updateProject(result.project);
      setSelection(result.selection);
      engine.current?.seek(start);
      if (midi !== null)
        void engine.current?.audition(part, midi).catch((error) => notify(cleanError(error), true));
    } catch (error) {
      notify(cleanError(error), true);
    }
  };
  const transpose = (semitones: number) => {
    try {
      updateProject(transposeProject(project, semitones));
    } catch (error) {
      notify(cleanError(error), true);
    }
  };
  const duplicateSelected = () => {
    if (!selectedNote) return;
    const result = insertNote(
      project,
      part.id,
      selectedNote.start + selectedNote.duration,
      selectedNote.duration,
      selectedNote.midi,
    );
    const newNote = result.project.parts
      .find((p) => p.id === part.id)!
      .notes.find((n) => n.id === result.selection.noteId)!;
    Object.assign(newNote, {
      lyric: selectedNote.lyric,
      dynamic: selectedNote.dynamic,
      articulation: selectedNote.articulation,
    });
    updateProject(result.project);
    setSelection(result.selection);
    engine.current?.seek(newNote.start);
  };
  const beginPlayback = async (
    startBeat = playingState.beat,
    mode = playbackMode,
    sourceUrl: string | null = stem?.url ?? null,
  ) => {
    setAudioBusy(true);
    try {
      await engine.current?.play(project, {
        mode,
        startBeat,
        loop,
        loopStart: (loopStart - 1) * barLength,
        loopEnd: loopEnd * barLength,
        metronome,
        countIn,
        sourceUrl: mode === 'source' ? (sourceUrl ?? undefined) : undefined,
      });
    } catch (error) {
      notify(cleanError(error), true);
    } finally {
      setAudioBusy(false);
    }
  };
  const togglePlay = (shouldPlay = !playingState.playing) => {
    if (audioBusy) return;
    if (shouldPlay) void beginPlayback();
    else engine.current?.pause();
  };
  const seekBeat = (beat: number) => {
    const next = Math.max(
      0,
      Math.min((playbackMode === 'source' ? sourceBeatLength(project) : totalBeats) - 0.001, beat),
    );
    if (playingState.playing) void beginPlayback(next);
    else engine.current?.seek(next);
  };
  const goToMeasure = (bar: number) => {
    setBarDraft(undefined);
    const target = Math.max(1, Math.min(project.measures, Math.round(bar)));
    const beat = (target - 1) * barLength;
    if (
      playingState.playing &&
      (!loop || (target >= loopStart && target <= loopEnd)) &&
      (playbackMode === 'score' || beat < sourceBeatLength(project))
    ) void beginPlayback(beat);
    else engine.current?.seek(beat);
  };
  const seekSource = (fraction: number) => {
    const next =
      (Math.max(0, fraction * sourceLength - (project.originalAudio?.offsetSeconds ?? 0)) * sourceTempo) / 60;
    setPlaybackMode('source');
    setStem(undefined);
    // React has not committed setStem yet; explicitly seek the original recording.
    if (playingState.playing) void beginPlayback(next, 'source', null);
    else engine.current?.seek(next);
  };
  const setTempo = (tempo: number) => {
    if (!Number.isFinite(tempo) || tempo < 30 || tempo > 240) return;
    updateProject({ ...project, tempo, updatedAt: new Date().toISOString() });
  };
  const changeWorkspaceMode = (mode: 'workbench' | 'practice') => {
    setTab(mode);
    setMobilePanel(undefined);
    if (mode === 'practice') {
      setSelection(undefined);
      setStepEntry(false);
    }
  };
  const openInspector = (mode: 'note' | 'check' = 'note') => {
    setTab('workbench');
    setInspectorTab(mode);
    setPanelPreference((value) => ({ ...value, inspector: true }));
    setMobilePanel('inspector');
  };
  const setRehearsalRange = (start: number, end: number, enable = false) => {
    engine.current?.pause();
    setLoopStart(Math.max(1, Math.min(project.measures, start)));
    setLoopEnd(Math.max(start, Math.min(project.measures, end)));
    if (enable) {
      setLoop(true);
      engine.current?.seek((start - 1) * barLength);
    }
  };
  const changePlaybackMode = (mode: PlaybackMode) => {
    engine.current?.pause();
    setPlaybackMode(mode);
    setStem(undefined);
  };
  const addPart = () => {
    if (project.parts.length >= 16) {
      notify('MVP 最多支持 16 个声部。', true);
      return;
    }
    const id = editId();
    const newPart: ScorePart = {
      id,
      name: `新声部 ${project.parts.length + 1}`,
      shortName: `V${project.parts.length + 1}`,
      instrument: active === 'arrangement' ? 'choir_aahs' : 'acoustic_grand_piano',
      program: active === 'arrangement' ? 52 : 0,
      role: 'harmony',
      clef: 'treble',
      color: '#6b8068',
      notes: [],
      muted: false,
      solo: false,
      volume: 0.72,
    };
    updateProject({ ...project, parts: [...project.parts, newPart] });
    setSelectedPartId(id);
    setSelection(undefined);
    setVisiblePart('all');
  };
  const downloadOriginal = async () => {
    if (!project.originalAudio?.url) return;
    try {
      downloadFile(await readOriginalFile(project.originalAudio), project.originalAudio.name);
    } catch (error) {
      notify(cleanError(error), true);
    }
  };
  const editChord = (index: number) => {
    setChordEdit(index);
    setChordDraft(project.chords[index].symbol);
  };
  const applyChord = () => {
    if (chordEdit === undefined) return;
    const match = chordDraft
      .trim()
      .match(/^([A-G])([#b]?)(maj7|m7b5|m7|m6|m|7|6|dim7|dim|aug|sus2|sus4|9)?(?:\/([A-G])([#b]?))?$/);
    if (!match) {
      notify('请使用常见和弦，如 C、Am7、Fmaj7、Csus4、C/E。', true);
      return;
    }
    const roots: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const root = 48 + roots[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
    const intervals: Record<string, number[]> = {
      '': [0, 4, 7],
      m: [0, 3, 7],
      '7': [0, 4, 7, 10],
      maj7: [0, 4, 7, 11],
      m7: [0, 3, 7, 10],
      m7b5: [0, 3, 6, 10],
      '6': [0, 4, 7, 9],
      m6: [0, 3, 7, 9],
      dim: [0, 3, 6],
      dim7: [0, 3, 6, 9],
      aug: [0, 4, 8],
      sus2: [0, 2, 7],
      sus4: [0, 5, 7],
      '9': [0, 4, 7, 10, 14],
    };
    const pitches = intervals[match[3] ?? ''].map((interval) => root + interval);
    if (match[4]) pitches.unshift(36 + roots[match[4]] + (match[5] === '#' ? 1 : match[5] === 'b' ? -1 : 0));
    updateProject({
      ...project,
      chords: project.chords.map((chord, index) =>
        index === chordEdit ? { ...chord, symbol: chordDraft.trim(), pitches, confidence: undefined } : chord,
      ),
    });
    setChordEdit(undefined);
    notify('和弦已修改；生成新编配时会采用此和声，已有音符不自动改变。');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        dialog ||
        chordEdit !== undefined
      )
        return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        setDialog('import');
        return;
      }
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (tab === 'practice') return;
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === 's') {
        event.preventDefault();
        downloadFile(
          serializeProject(project),
          `${project.title.replace(/[\\/]/g, '-')}.coro.json`,
          'application/json',
        );
        return;
      }
      if (event.code === 'Space') {
        if (target.closest('button, a[href], summary')) return;
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setDialog('help');
        return;
      }
      if (event.key === 'Escape') {
        setSelection(undefined);
        setStepEntry(false);
        engine.current?.pause();
        return;
      }
      if (tab === 'practice') {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          seekBeat(playingState.beat + (event.key === 'ArrowRight' ? 1 : -1) * barLength);
        }
        return;
      }
      if (event.key.toLowerCase() === 'n' && !command) {
        event.preventDefault();
        setStepEntry((value) => !value);
        return;
      }
      if (event.key.toLowerCase() === 'r' && !command) {
        event.preventDefault();
        if (selection) changeNote({ midi: selectedNote?.midi === null ? 60 : null });
        else addNote(null);
        return;
      }
      if (['1', '2', '3', '4', '5'].includes(event.key)) {
        setEntryDuration([4, 2, 1, 0.5, 0.25][Number(event.key) - 1]);
        return;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && selection) {
        event.preventDefault();
        removeNote();
        return;
      }
      if (selectedNote && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        changeNote({
          midi: (selectedNote.midi ?? 60) + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1),
        });
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (selection) {
          const index = part.notes.findIndex((note) => note.id === selection.noteId);
          const note = part.notes[index + (event.key === 'ArrowRight' ? 1 : -1)];
          if (note) selectNote({ partId: part.id, noteId: note.id });
        } else seekBeat(playingState.beat + (event.key === 'ArrowRight' ? 1 : -1) * barLength);
        return;
      }
      if (stepEntry && /^[a-g]$/i.test(event.key) && !command) {
        event.preventDefault();
        const pc: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
        const base =
          selectedNote?.midi !== null && selectedNote?.midi !== undefined
            ? Math.floor(selectedNote.midi / 12) * 12
            : part.clef === 'bass'
              ? 48
              : 60;
        addNote(base + pc[event.key.toLowerCase()]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div
      className={`app-shell ${tab === 'practice' ? 'practice-mode' : ''} ${mobilePanel ? `show-${mobilePanel}` : ''} ${partsOpen ? '' : 'parts-collapsed'} ${inspectorOpen ? '' : 'inspector-collapsed'}`}
    >
      <a className="skip-link" href="#score-workspace">
        跳到乐谱
      </a>
      <header className="app-header">
        <button className="brand" onClick={() => setDialog('library')} aria-label="Coro 合声，打开工程库">
          <span className="brand-mark">c</span>
          <span className="brand-word">
            coro<span className="brand-chinese">合声</span>
          </span>
        </button>
        <div className="header-project">
          <button className="project-title" title="编辑工程信息" onClick={() => setDialog('project')}>
            <h1>{source.title.split(' / ')[0]}</h1>
            <CaretDown size={13} />
          </button>
          <span>
            {project.key} {project.key.endsWith('m') ? '小调' : '大调'}
            <i />
            {project.timeSignature.join('/')}
            <i />
            {project.measures} 小节
          </span>
        </div>
        <nav className="main-nav" aria-label="工作模式">
          <button
            className={tab === 'workbench' ? 'active' : ''}
            aria-label="编配工作台"
            aria-current={tab === 'workbench' ? 'page' : undefined}
            onClick={() => changeWorkspaceMode('workbench')}
          >
            <NotePencil size={17} />
            编配工作台
          </button>
          <button
            className={tab === 'practice' ? 'active' : ''}
            aria-current={tab === 'practice' ? 'page' : undefined}
            onClick={() => changeWorkspaceMode('practice')}
          >
            <Headphones size={17} />
            排练室
          </button>
        </nav>
        <div className="header-right">
          <span className={`save-status ${saved === 'error' ? 'save-error' : ''}`}>
            {saved === 'saved' ? (
              <CheckCircle size={14} />
            ) : saved === 'saving' ? (
              <CircleNotch className="spin" size={14} />
            ) : (
              <WarningCircle size={14} />
            )}
            {saved === 'saved' ? '已保存' : saved === 'saving' ? '保存中' : '保存失败，请导出'}
          </span>
          <button
            className="icon-button help-button"
            title="帮助与快捷键 (?)"
            aria-label="帮助与快捷键"
            onClick={() => setDialog('help')}
          >
            <Keyboard size={20} />
          </button>
          <button className="primary-button compact" onClick={() => setDialog('export')}>
            <ArrowDown size={16} />
            导出
          </button>
        </div>
      </header>

      <aside id="parts-panel" className="parts-sidebar" aria-label={tab === 'practice' ? '排练面板' : '编配面板'}>
        <div className="workspace-heading">
          <button onClick={() => setDialog('library')}>
            <FolderOpen size={17} />
            工程库
          </button>
          <button
            className="icon-button"
            aria-label="新建空白乐谱"
            title="新建空白乐谱"
            onClick={() => importProject(createBlankProject())}
          >
            <FilePlus size={17} />
          </button>
          <button
            className="icon-button mobile-close"
            aria-label="关闭声部面板"
            onClick={() => setMobilePanel(undefined)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="import-button" onClick={() => setDialog('import')}>
          <UploadSimple size={16} />
          导入音乐<span>⌘ O</span>
        </button>
        {tab === 'practice' ? (
          <PracticePanel
            project={project}
            focusPartId={practicePartId}
            loop={loop}
            loopStart={loopStart}
            loopEnd={loopEnd}
            onFocus={(id) => {
              setPracticePartId(id);
              setMobilePanel(undefined);
            }}
            onSolo={(id) => {
              const target = project.parts.find((item) => item.id === id)!;
              updateProject(changePart(project, id, { solo: !target.solo }), false, false);
            }}
            onSection={(start, end) => setRehearsalRange(start, end, true)}
            onWhole={() => {
              engine.current?.pause();
              setLoop(false);
            }}
            onEdit={() => changeWorkspaceMode('workbench')}
          />
        ) : (
          <EnsemblePanel
            project={project}
            selectedPartId={part.id}
            visiblePartId={visiblePart}
            sourceMode={playbackMode === 'source'}
            onSelect={(id) => {
              setSelectedPartId(id);
              setSelection(undefined);
              setInspectorTab('note');
            }}
            onMix={(id, patch) => updateProject(changePart(project, id, patch), false, false)}
            onView={(id) => {
              setVisiblePart(visiblePart === id ? 'all' : id);
              setSelectedPartId(id);
              setSelection(undefined);
            }}
            onStem={(item) => {
              engine.current?.pause();
              setStem({ url: item.stemUrl!, name: item.name });
              setPlaybackMode('source');
              setSourceOpen(true);
              notify(`已选择「${item.name}」原声分离轨，可能漏音或串音。试听识别结果请选择底部「谱曲」。`);
            }}
            onAdd={addPart}
          />
        )}
        <div className="sidebar-footer">
          <div className="local-badge">
            <LockKey size={14} />
            <span>音频与工程仅存本机</span>
          </div>
          <button className="engine-badge" onClick={() => setDialog('help')}>
            <span className={`status-dot ${engineReady ? 'online' : ''}`} />
            {engineReady === undefined
              ? '检查本地引擎'
              : engineReady
                ? '本地音频引擎就绪'
                : '谱曲可用 · 转谱引擎离线'}
            <Info size={13} />
          </button>
        </div>
      </aside>

      <main
        className="workbench"
        id="score-workspace"
        tabIndex={-1}
        aria-label={tab === 'practice' ? '排练阅谱' : '编配乐谱'}
      >
        {dialog !== 'import' && localStorage.getItem(PENDING_ANALYSIS_KEY) && (
          <div className="pending-analysis-banner">
            <CircleNotch className="spin" size={16} />
            <span>本地分析进行中，当前乐谱仍可编辑。</span>
            <button onClick={() => setDialog('import')}>
              查看进度 <ArrowRight size={14} />
            </button>
          </div>
        )}
        <div className="document-bar">
          <button
            className="mobile-toggle icon-button"
            aria-label="显示声部面板"
            aria-controls="parts-panel"
            aria-expanded={mobilePanel === 'parts'}
            title={tab === 'practice' ? '练习声部与片段' : '声部与混音'}
            onClick={() => setMobilePanel('parts')}
          >
            <List size={20} />
          </button>
          <button
            className="desk-parts-toggle panel-toggle"
            aria-label={partsOpen ? '收起声部面板' : '显示声部面板'}
            aria-controls="parts-panel"
            aria-expanded={partsOpen}
            onClick={() => setPanelPreference((value) => ({ ...value, parts: !partsOpen }))}
          >
            <List size={17} />
            <span>声部</span>
          </button>
          <div className="document-tabs" role="tablist" aria-label="乐谱版本">
            <button role="tab" aria-selected={active === 'source'} onClick={() => switchDocument('source')}>
              <PianoKeys size={16} />
              原曲总谱
            </button>
            <ArrowRight className="document-flow" size={13} />
            <button
              role="tab"
              aria-selected={active === 'arrangement'}
              onClick={() => switchDocument('arrangement')}
            >
              <MicrophoneStage size={16} />
              阿卡贝拉
              {arrangement ? (
                <span className="tab-count">
                  {arrangement.arrangement?.options.preset.toUpperCase() ?? arrangement.parts.length}
                </span>
              ) : (
                <span className="tab-new">生成</span>
              )}
            </button>
          </div>
          <div className="document-tools">
            <span
              className={`source-badge ${project.source.kind === 'audio' || project.source.kind === 'omr' ? 'needs-review' : ''}`}
            >
              {project.source.kind === 'demo'
                ? '原创示例'
                : project.source.kind === 'audio'
                  ? '机器转谱 · 待校对'
                  : project.source.kind === 'omr'
                    ? '光学识谱 · 待校对'
                    : project.source.kind === 'manual'
                      ? '手写乐谱'
                      : '导入乐谱'}
            </span>
            <button
              className="arrange-cta"
              aria-label={
                arrangement ? '重新编配 保留原谱 · 调整编制与风格' : '一键编成阿卡贝拉 从乐器，到人声。'
              }
              onClick={() => setDialog('arrange')}
            >
              <Sparkle size={15} />
              <span>{arrangement ? '重新编配' : '生成阿卡贝拉'}</span>
            </button>
            {tab === 'workbench' && (
              <>
                <button
                  className="panel-toggle desk-inspector-toggle"
                  aria-label={inspectorOpen ? '收起编辑面板' : '显示编辑面板'}
                  aria-expanded={inspectorOpen}
                  onClick={() => setPanelPreference((value) => ({ ...value, inspector: !inspectorOpen }))}
                >
                  <SlidersHorizontal size={17} />
                  <span>属性</span>
                </button>
                <button
                  className="icon-button inspector-toggle"
                  aria-label="显示编辑面板"
                  aria-expanded={mobilePanel === 'inspector'}
                  title="音符属性与校对"
                  onClick={() => openInspector('note')}
                >
                  <SlidersHorizontal size={18} />
                </button>
              </>
            )}
          </div>
        </div>
        {tab === 'practice' && (
          <div className="practice-banner">
            <div>
              <span className="practice-mode-tag">只读排练</span>
              <strong>
                {practicePartId === 'all'
                  ? '完整合唱'
                  : project.parts.find((item) => item.id === practicePartId)?.name.split(' · ')[0]}
              </strong>
              <span>{loop ? `循环 ${loopStart}–${loopEnd} 小节` : '全曲练习'}</span>
            </div>
            <p>点击音符定位，空格开始 / 暂停</p>
            <div className="practice-zoom">
              <button
                className="icon-button"
                aria-label="缩小谱面"
                disabled={zoom <= 75}
                onClick={() => setZoom((value) => value - 10)}
              >
                <Minus size={15} />
              </button>
              <button className="zoom-value" title="恢复缩放" onClick={() => setZoom(100)}>
                {zoom}%
              </button>
              <button
                className="icon-button"
                aria-label="放大谱面"
                disabled={zoom >= 150}
                onClick={() => setZoom((value) => value + 10)}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
        )}
        {tab === 'workbench' && (
          <div className="editing-toolbar" aria-label="乐谱编辑工具">
            <div className="tool-group">
              <button
                className="icon-button"
                aria-label="撤销"
                title="撤销 (⌘ Z)"
                disabled={!history.current[active].past.length}
                onClick={undo}
              >
                <ArrowCounterClockwise size={18} />
              </button>
              <button
                className="icon-button"
                aria-label="重做"
                title="重做 (⌘ ⇧ Z)"
                disabled={!history.current[active].future.length}
                onClick={redo}
              >
                <ArrowClockwise size={18} />
              </button>
            </div>
            <span className="tool-divider" />
            <div className="tool-group entry-tools">
              <button
                className={`icon-button ${stepEntry ? 'active-tool' : ''}`}
                aria-label="逐步输入音符"
                title="逐步输入 (N)，再按 A–G"
                aria-pressed={stepEntry}
                onClick={() => setStepEntry((value) => !value)}
              >
                <NotePencil size={19} />
              </button>
              {[4, 2, 1, 0.5, 0.25].map((value) => (
                <button
                  key={value}
                  className={`duration-button ${entryDuration === value ? 'active-tool' : ''}`}
                  aria-label={`输入${durationOptions.find((option) => option.value === value)?.label}`}
                  aria-pressed={entryDuration === value}
                  title={durationOptions.find((option) => option.value === value)?.label}
                  onClick={() => setEntryDuration(value)}
                >
                  {durationGlyphs[value]}
                </button>
              ))}
              <button className="text-tool" onClick={() => addNote()} title="在播放光标位置添加音符">
                <Plus size={14} />
                音符
              </button>
              <button
                className="text-tool rest-tool"
                onClick={() => addNote(null)}
                title="在播放光标位置添加休止符 (R)"
              >
                休止
              </button>
            </div>
            <span className="tool-divider" />
            <div className="tool-group transpose-tools">
              <button
                className="icon-button"
                aria-label="全曲降低半音"
                title="全曲降低半音（含和弦）"
                onClick={() => transpose(-1)}
              >
                <span className="transpose-icon">♭</span>
              </button>
              <button
                className="icon-button"
                aria-label="全曲升高半音"
                title="全曲升高半音（含和弦）"
                onClick={() => transpose(1)}
              >
                <span className="transpose-icon">♯</span>
              </button>
            </div>
            <div className="toolbar-spacer" />
            <button
              className="text-tool"
              title="局部移调、节奏量化、高低音谱表与批量歌词"
              aria-label="整理与批量校正"
              onClick={() => {
                setRepairEntry('staff');
                setDialog('repair');
              }}
            >
              <SlidersHorizontal size={15} />
              整理
            </button>
            {readableHint && (
              <button
                className="text-tool"
                aria-label="预览记谱调整"
                title={`减少细碎符号。记谱单位可改为 ${readableHint.targetTempo.toFixed(1)} BPM，播放秒数、音高和音符数量不变。`}
                onClick={() => {
                  setRepairEntry('beat');
                  setDialog('repair');
                }}
              >
                记谱建议
              </button>
            )}
            <button
              className={`confidence-toggle ${showConfidence ? 'on' : ''}`}
              title="高亮模型低置信音符（不代表校准准确率）"
              aria-pressed={showConfidence}
              onClick={() => setShowConfidence((value) => !value)}
            >
              <span />
              待校对
            </button>
            <span className="tool-divider" />
            <div className="tool-group zoom-tools">
              <button
                className="icon-button"
                aria-label="缩小谱面"
                disabled={zoom <= 75}
                onClick={() => setZoom((value) => value - 10)}
              >
                <Minus size={15} />
              </button>
              <button className="zoom-value" onClick={() => setZoom(100)} title="恢复缩放">
                {zoom}%
              </button>
              <button
                className="icon-button"
                aria-label="放大谱面"
                disabled={zoom >= 150}
                onClick={() => setZoom((value) => value + 10)}
              >
                <Plus size={15} />
              </button>
            </div>
            <button
              className="icon-button source-code-button"
              title="MusicXML 源码编辑"
              aria-label="编辑 MusicXML 源码"
              onClick={() => {
                setXmlDraft(toMusicXml(project));
                setXmlError('');
                setDialog('source');
              }}
            >
              <DotsThree size={21} weight="bold" />
            </button>
          </div>
        )}

        {stepEntry && (
          <div className="step-entry-notice">
            <NotePencil size={15} />
            逐步输入已开启 · 按 A–G 输入音高，1–5 选时值，R 输入休止，Esc 退出。
            <button onClick={() => setStepEntry(false)}>退出</button>
          </div>
        )}
        <div className="measure-rail" aria-label="小节导航">
          <div className="measure-pages">
            <button
              className="icon-button"
              aria-label="上一段小节"
              title="上一段小节"
              disabled={!measureRange || measureRange.start <= 1}
              onClick={() => measureRange && pageSize !== 'all' && goToMeasure(measureRange.start - pageSize)}
            >
              <CaretLeft size={15} />
            </button>
            <span className="measure-range" aria-live="polite">
              {measureRange
                ? `${measureRange.start}–${measureRange.end} / ${project.measures}`
                : `全曲 · ${project.measures} 小节`}
            </span>
            <button
              className="icon-button"
              aria-label="下一段小节"
              title="下一段小节"
              disabled={!measureRange || measureRange.end >= project.measures}
              onClick={() => measureRange && goToMeasure(measureRange.end + 1)}
            >
              <CaretRight size={15} />
            </button>
          </div>
          <form className="measure-jump" onSubmit={(event) => {
            event.preventDefault();
            const target = Number(barDraft ?? currentBar);
            if (Number.isFinite(target)) goToMeasure(target);
          }}>
            <input
              type="number"
              min={1}
              max={project.measures}
              required
              aria-label="跳转小节"
              value={barDraft ?? currentBar}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setBarDraft(event.target.value)}
            />
            <button type="submit" title="跳转到输入的小节">跳转</button>
          </form>
          <select
            className="measure-page-size"
            aria-label="每段显示小节"
            value={pageSize}
            onChange={(event) => setPageSize(event.target.value === 'all' ? 'all' : event.target.value === '8' ? 8 : 4)}
          >
            <option value={4}>每段 4 小节</option>
            <option value={8}>每段 8 小节</option>
            <option value="all">全曲</option>
          </select>
          <select
            className="score-scope-select"
            aria-label="谱面声部"
            value={tab === 'practice' ? practicePartId : visiblePart}
            onChange={(event) => {
              const id = event.target.value;
              if (tab === 'practice') setPracticePartId(id);
              else {
                setVisiblePart(id);
                setSelection(undefined);
                if (id !== 'all') setSelectedPartId(id);
              }
            }}
          >
            <option value="all">完整总谱</option>
            {project.parts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button measure-edit-action"
            aria-label="添加空白小节"
            title="末尾添加一个空白小节"
            onClick={() => updateProject({ ...project, measures: project.measures + 1 })}
          >
            <Plus size={15} />
          </button>
          <button
            className="icon-button duplicate-bar measure-edit-action"
            aria-label="复制当前小节"
            title="在后方复制当前小节"
            onClick={() => updateProject(duplicateMeasure(project, currentBar))}
          >
            <Copy size={15} />
          </button>
        </div>
        <div className="score-scroll" data-testid="score-scroll">
          <ScoreView
            project={project}
            visiblePartIds={
              tab === 'practice'
                ? practicePartId === 'all'
                  ? undefined
                  : [practicePartId]
                : visiblePart === 'all'
                  ? undefined
                  : [visiblePart]
            }
            selection={selection}
            beat={playingState.beat}
            playing={playingState.playing}
            zoom={zoom}
            showConfidence={showConfidence}
            measureRange={printing ? undefined : measureRange}
            onSelect={selectNote}
            readingMode={tab === 'practice'}
          />
        </div>
        <div className="score-status">
          <div>
            <span className="status-dot online" />
            {playingState.playing
              ? playbackMode === 'score'
                ? '谱曲播放中'
                : '原音频播放中'
              : selection
                ? `${part.shortName} · ${selectedNote?.midi === null ? '休止符' : selectedNote ? pitchName(selectedNote.midi!) : ''}`
                : tab === 'practice'
                  ? '排练模式，不改动音符'
                  : '点击音符以编辑'}
            <span className="score-status-hint">
              {stepEntry
                ? '逐步输入模式'
                : tab === 'practice'
                  ? '← → 切小节 · 空格播放'
                  : '↑ ↓ 调音高 · ⌘ Z 撤销'}
            </span>
          </div>
          <button className="score-review-link" onClick={() => openInspector('check')}>
            <WarningCircle size={14} />
            排练前校对
          </button>
        </div>
        {visibleChords.length > 0 && (
          <div className="chord-strip">
            <span>和声</span>
            <div>
              {visibleChords.map(({ chord, index, bar }) => (
                <button
                  key={`${chord.start}-${index}`}
                  className={
                    playingState.beat >= chord.start && playingState.beat < chord.start + chord.duration
                      ? 'current'
                      : ''
                  }
                  title={`第 ${bar} 小节，${tab === 'practice' ? '点击定位' : '点击编辑和弦'}`}
                  onClick={() => (tab === 'practice' ? seekBeat(chord.start) : editChord(index))}
                >
                  <small>{bar}</small>
                  {chord.symbol}
                </button>
              ))}
            </div>
          </div>
        )}
        <SourceReference
          open={sourceOpen}
          onToggle={() => setSourceOpen((value) => !value)}
          ready={Boolean(project.originalAudio)}
          busy={demoBusy}
          demo={source.source.kind === 'demo'}
          name={project.originalAudio?.name}
          stemName={stem?.name}
          sourceMode={playbackMode === 'source'}
          duration={sourceLength}
          peaks={peaks}
          progress={sourceFraction}
          onSeek={seekSource}
          onListen={() => changePlaybackMode(playbackMode === 'source' ? 'score' : 'source')}
          onDownload={() => void downloadOriginal()}
          onImport={() => setDialog('import')}
        />
        <SourceEvidence
          project={project}
          onImportCopy={importProject}
          onMessage={notify}
          onReanalyze={() => {
            engine.current?.pause();
            setDialog('import');
          }}
          onVocalRebuild={vocalRebuildSourceId(source) ? () => {
            engine.current?.pause();
            setDialog('vocal-rebuild');
          } : undefined}
          onSeek={(seconds) => seekSource(Math.max(0, Math.min(1, seconds / sourceLength)))}
          onAudio={(url, name) => {
            engine.current?.pause();
            setStem({ url, name });
            setPlaybackMode('source');
            notify(`已选择${name}，点击底部播放。`);
          }}
          onPitchReview={(seconds) => {
            engine.current?.pause();
            setPitchReviewSeconds(seconds);
            setActive('source');
            setTab('workbench');
            setMobilePanel(undefined);
            setDialog('pitch-review');
          }}
        />
      </main>

      {mobilePanel && (
        <button className="panel-scrim" aria-label="关闭侧边面板" onClick={() => setMobilePanel(undefined)} />
      )}
      {mobilePanel === 'inspector' && (
        <button
          className="inspector-mobile-close"
          aria-label="关闭编辑面板"
          onClick={() => setMobilePanel(undefined)}
        >
          <X size={20} />
        </button>
      )}
      <Inspector
        project={project}
        part={part}
        tab={inspectorTab}
        onTabChange={setInspectorTab}
        selection={selection}
        onChangeNote={changeNote}
        onChangePart={(patch) => updateProject(changePart(project, part.id, patch))}
        onDelete={removeNote}
        onDuplicate={duplicateSelected}
        onAudition={(midi) => {
          void engine.current?.audition(part, midi).catch((error) => notify(cleanError(error), true));
        }}
        onSelect={selectNote}
      />

      <TransportBar
        project={project}
        state={playingState}
        mode={playbackMode}
        busy={audioBusy}
        audioReady={Boolean(project.originalAudio) && !demoBusy}
        stemName={stem?.name}
        loop={loop}
        loopStart={loopStart}
        loopEnd={loopEnd}
        metronome={metronome}
        countIn={countIn}
        onMode={changePlaybackMode}
        onPlay={togglePlay}
        onStop={() => engine.current?.seek(0)}
        onPrevious={() => seekBeat(Math.max(0, currentBar - 2) * barLength)}
        onTempo={setTempo}
        onMetronome={() => setMetronome((value) => !value)}
        onCountIn={setCountIn}
        onLoop={() => {
          engine.current?.pause();
          setLoop((value) => !value);
        }}
        onRange={setRehearsalRange}
      />

      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          {toast.error ? <WarningCircle size={19} /> : <CheckCircle size={19} />}
          <span>{toast.text}</span>
          <button aria-label="关闭提示" onClick={() => setToast(undefined)}>
            <X size={15} />
          </button>
        </div>
      )}
      {dialog === 'import' && (
        <ImportDialog
          onClose={() => setDialog(undefined)}
          onImport={importProject}
          onWorkspace={openWorkspace}
          onDemo={() => {
            generatedDemo.current = undefined;
            importProject(createDemoProject());
          }}
        />
      )}
      {dialog === 'arrange' && (
        <ArrangeDialog
          project={source}
          initialOptions={arrangement?.arrangement?.options}
          onClose={() => setDialog(undefined)}
          onArrange={arrange}
        />
      )}
      {dialog === 'export' && (
        <ExportDialog
          project={project}
          workspace={{ source, arrangement, active, savedAt: new Date().toISOString() }}
          onClose={() => setDialog(undefined)}
          onDone={notify}
        />
      )}
      {dialog === 'pitch-review' && (
        <PitchReviewDialog key={source.id} project={source} initialSeconds={pitchReviewSeconds} hasArrangement={Boolean(arrangement)}
          onClose={()=>setDialog(undefined)} onApply={async (draft)=>{
            const state = { ...workspaceRef.current, source: draft, savedAt: new Date().toISOString() };
            await archiveWorkspace(state);
            saveWorkspace(state);
            updateProject(draft);
            notify('原曲主唱修正已应用，可撤销；已有编配和模型证据保持不变。');
          }}/>
      )}
      {dialog === 'vocal-rebuild' && (
        <VocalRebuildDialog project={source} hasArrangement={Boolean(arrangement)}
          onBeforeStart={async () => {
            const state = { ...workspaceRef.current, savedAt: new Date().toISOString() };
            try {
              await archiveWorkspace(state);
              saveWorkspace(state);
            } catch {
              throw new Error('暂时无法安全保存旧工程，请先导出便携工程备份或释放浏览器空间，再重建主唱。');
            }
            setSaved('saved');
          }}
          onClose={() => setDialog(undefined)} onOpen={async (next) => {
            if (!await importProject(next)) return false;
            setTab('workbench');
            setVisiblePart('vocals');
            notify('已打开主唱重建副本。旧总谱和编配保留在工程库，其他声部与和弦保持不变。');
            return true;
          }} />
      )}
      {dialog === 'project' && (
        <Modal title="乐谱信息" eyebrow="PROJECT SETTINGS" onClose={() => setDialog(undefined)}>
          <div className="project-fields">
            <label className="field-label">
              标题
              <input
                aria-label="乐谱标题"
                value={project.title}
                maxLength={160}
                onChange={(event) => updateProject({ ...project, title: event.target.value })}
              />
            </label>
            <label className="field-label">
              作曲 / 编配
              <input
                aria-label="作曲者"
                value={project.composer}
                maxLength={100}
                onChange={(event) => updateProject({ ...project, composer: event.target.value })}
              />
            </label>
            <div className="field-pair">
              <label className="field-label">
                调号
                <select
                  aria-label="调号"
                  value={project.key}
                  onChange={(event) => updateProject({ ...project, key: event.target.value })}
                >
                  {[
                    'Cb',
                    'Gb',
                    'Db',
                    'Ab',
                    'Eb',
                    'Bb',
                    'F',
                    'C',
                    'G',
                    'D',
                    'A',
                    'E',
                    'B',
                    'F#',
                    'C#',
                    'Abm',
                    'Ebm',
                    'Bbm',
                    'Fm',
                    'Cm',
                    'Gm',
                    'Dm',
                    'Am',
                    'Em',
                    'Bm',
                    'F#m',
                    'C#m',
                    'G#m',
                    'D#m',
                    'A#m',
                  ].map((key) => (
                    <option key={key}>{key}</option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                拍号
                <select
                  aria-label="拍号"
                  value={project.timeSignature.join('/')}
                  onChange={(event) => {
                    const meter = event.target.value.split('/').map(Number) as [number, number];
                    const length = (meter[0] * 4) / meter[1];
                    updateProject({
                      ...project,
                      timeSignature: meter,
                      measures: Math.max(1, Math.ceil(totalBeats / length)),
                    });
                  }}
                >
                  {['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'].map((meter) => (
                    <option key={meter}>{meter}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="subtle-note">
              修改调号不改变实际音高；如要整体移调，请使用工具栏 ♭ /
              ♯。修改拍号会重新分小节，音符的绝对时间不变。
            </p>
            <div className="settings-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  setDialog(undefined);
                  updateProject({ ...project, measures: project.measures + 1 });
                }}
              >
                添加空白小节
              </button>
              <button
                className="text-button danger"
                disabled={project.parts.length <= 1}
                onClick={() => setDialog('delete-part')}
              >
                删除当前声部
              </button>
            </div>
          </div>
          <div className="modal-actions">
            <span className="subtle-note">改动自动保存，可撤销。</span>
            <button className="primary-button" onClick={() => setDialog(undefined)}>
              完成 <Check size={17} />
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'library' && (
        <LibraryDialog workspace={{ source, arrangement, active, savedAt: new Date().toISOString() }}
          onClose={() => setDialog(undefined)} onOpen={openWorkspace} onImport={importProject}
          onNew={() => { void importProject(createBlankProject()); }}
          onDemo={() => { generatedDemo.current = undefined; void importProject(createDemoProject()); }}
          onExport={() => setDialog('export')} onChooseImport={() => setDialog('import')} />
      )}
      {dialog === 'delete-part' && (
        <Modal title="删除这个声部？" onClose={() => setDialog(undefined)}>
          <p className="modal-description">
            将删除「{part.name}」及它的 {part.notes.length} 个音符。此操作可以通过撤销恢复，不影响原音频。
          </p>
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setDialog(undefined)}>
              保留
            </button>
            <button
              className="primary-button danger-background"
              onClick={() => {
                const next = { ...project, parts: project.parts.filter((item) => item.id !== part.id) };
                updateProject(next);
                setSelectedPartId(next.parts[0].id);
                setSelection(undefined);
                setVisiblePart('all');
                setDialog(undefined);
              }}
            >
              删除声部
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'source' && (
        <Modal title="MusicXML 源码" eyebrow="ADVANCED EDITING" onClose={() => setDialog(undefined)} wide>
          <p className="modal-description">
            与当前乐谱同步的交换格式。应用后会重新导入，覆盖当前版本的音符；可撤销。复杂排版与变速记号仍受 MVP
            数据模型限制。
          </p>
          <textarea
            className="xml-editor"
            aria-label="MusicXML 源码"
            value={xmlDraft}
            spellCheck={false}
            onChange={(event) => setXmlDraft(event.target.value)}
          />
          {xmlError && (
            <p className="error-message" role="alert">
              {xmlError}
            </p>
          )}
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setDialog(undefined)}>
              取消
            </button>
            <button
              className="primary-button"
              onClick={() => {
                try {
                  const next = fromMusicXml(xmlDraft);
                  updateProject({ ...next, id: project.id, originalAudio: project.originalAudio });
                  setSelection(undefined);
                  setSelectedPartId(next.parts[0].id);
                  setVisiblePart('all');
                  setDialog(undefined);
                } catch (error) {
                  setXmlError(cleanError(error));
                }
              }}
            >
              应用到当前乐谱 <Check size={17} />
            </button>
          </div>
        </Modal>
      )}
      {chordEdit !== undefined && (
        <Modal
          title="编辑和弦"
          eyebrow={`BAR ${Math.floor(project.chords[chordEdit].start / barLength) + 1}`}
          onClose={() => setChordEdit(undefined)}
        >
          <label className="field-label">
            和弦符号
            <input
              autoFocus
              aria-label="和弦符号"
              value={chordDraft}
              onChange={(event) => setChordDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyChord();
              }}
            />
          </label>
          <p className="subtle-note">
            支持常见大小三和弦、七和弦、九和弦、sus、dim、aug
            与转位。修改和弦不会自动重写已有音符；可据此重新生成阿卡贝拉编配。
          </p>
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setChordEdit(undefined)}>
              取消
            </button>
            <button className="primary-button" onClick={applyChord}>
              应用 <Check size={17} />
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(undefined)} />}
      {dialog === 'repair' && (
        <RepairDialog
          project={project}
          partId={part.id}
          currentMeasure={currentBar}
          initialOperation={repairEntry}
          initialFactor={repairEntry === 'beat' ? 2 : 0.5}
          onApply={(next) => {
            updateProject(next);
            setSelection(undefined);
            setVisiblePart('all');
            setPracticePartId('all');
            if (next.tempo !== project.tempo || next.measures !== project.measures) {
              engine.current?.seek(0); setLoop(false); setLoopStart(1); setLoopEnd(Math.min(4, next.measures));
            }
            notify('整理已应用，可撤销。原始音频保持不变。');
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="使用与能力边界" eyebrow="CORO GUIDE" onClose={onClose} wide>
      <div className="help-columns">
        <section>
          <h3>从音频到排练</h3>
          <ol className="help-steps">
            <li>
              <strong>导入</strong>
              <p>上传本地音频，或打开 MIDI / MusicXML。分轨模式保留分离音轨供对照。</p>
            </li>
            <li>
              <strong>校对</strong>
              <p>确认速度、拍号、旋律、和声及音符时值。低置信音符以琥珀色高亮。</p>
            </li>
            <li>
              <strong>编配</strong>
              <p>选择 SATB、SSAA 或 TTBB。检查音域、换气与主旋律，修改拟声音节。</p>
            </li>
            <li>
              <strong>排练</strong>
              <p>
                切到排练室，先选要看的声部，再选循环片段。选谱不改变混音，按 S
                才独奏；排练模式不会用快捷键改音符。
              </p>
            </li>
          </ol>
        </section>
        <section>
          <h3>常用快捷键</h3>
          <p className="subtle-note">
            编辑快捷键仅在编配工作台生效。排练室保留空格播放、左右切小节和 Esc 停止。
          </p>
          <div className="shortcut-list">
            {[
              ['空格', '播放 / 暂停'],
              ['↑ / ↓', '选中音符升降半音'],
              ['⇧ ↑ / ↓', '选中音符升降八度'],
              ['← / →', '相邻音符 / 小节'],
              ['N', '切换逐步输入'],
              ['A–G', '输入音符（逐步模式）'],
              ['1–5', '全 / 二分 / 四分 / 八分 / 十六分'],
              ['R', '输入 / 转换休止符'],
              ['Delete', '删除选中音符'],
              ['⌘ Z / ⌘ ⇧ Z', '撤销 / 重做'],
              ['⌘ S', '下载 Coro 工程'],
              ['Esc', '停止 / 退出逐步输入'],
            ].map(([key, label]) => (
              <div key={key}>
                <kbd>{key}</kbd>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="help-boundaries">
        <h3>
          <Info size={18} />
          关于这个 MVP，请知道这些
        </h3>
        <p>
          <strong>真实模型，不是万能扒谱。</strong> Basic Pitch 识别音高与起止，Demucs 分为六类声源，AudioSet
          模型仅给音色候选；不能可靠地把“其余”中的每种管弦乐器逐一拆出。谱面里的数值不是已校准准确率。
        </p>
        <p>
          <strong>自动编配，不等于自动可演出。</strong>{' '}
          生成的是基于声域、和声连接、换气和音型规则的草稿。没有自动转写歌词，没有真人音色克隆，合唱播放是本地
          Ah 采样；打击乐为合成排练音。
        </p>
        <p>
          <strong>编辑核心已打通，尚非 Crescendo 全量替代。</strong>{' '}
          可编辑音高、时值、休止、歌词、力度、演奏法、调号、拍号与声部，支持撤销和交换格式。复杂变速、反复、跨声部连线和出版排版需要专业打谱软件继续处理。
        </p>
        <p>
          <strong>隐私与版权。</strong> 本地浏览器保存谱面，本地 data
          目录保存上传音频；不上传、不训练。仅处理你有权改编的内容。清除浏览器数据会删除乐谱缓存，请定期导出。
        </p>
        <p className="credits">
          Notation: abcjs · Audio transcription: Basic Pitch / Demucs · Soundfonts: FluidR3_GM, Frank Wen and
          contributors, CC BY 3.0, via paulrosen / gleitz. 部分离线音色与谱面经验复用自 ChordHold。
        </p>
      </div>
      <div className="modal-actions">
        <span className="subtle-note">本地版需要同时运行前端和音频服务：npm start</span>
        <button className="primary-button" onClick={onClose}>
          开始创作 <ArrowRight size={17} />
        </button>
      </div>
    </Modal>
  );
}
