import type { NoteEvent, ScorePart, ScoreProject } from './types';
import { validateProject } from './music';
import { noteGateRatio, notePlaybackLevel } from './dynamics';
import { performanceNotes } from './performance';

type Context = AudioContext | OfflineAudioContext;
type Bank = Record<string, string>;
export type PlaybackMode = 'score' | 'source';
export interface PlaybackState {
  playing: boolean;
  beat: number;
  mode: PlaybackMode;
  peak: number;
}
export interface PlaybackOptions {
  mode: PlaybackMode;
  startBeat: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  metronome: boolean;
  countIn: boolean;
  sourceUrl?: string;
}

const bankPromises = new Map<string, Promise<Bank>>();
/** Seconds of music that must have decoded samples before score playback starts. */
export const PLAYBACK_READY_SECONDS = 2.5;
const sampleBuffers = new Map<string, AudioBuffer>();
const flatNames = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const nameForMidi = (midi: number) => `${flatNames[midi % 12]}${Math.floor(midi / 12) - 1}`;
const quarterBeats = (project: ScoreProject) => (project.timeSignature[0] * 4) / project.timeSignature[1];

function bankFor(part: ScorePart): string {
  if (part.role !== 'instrument' && part.role !== 'percussion') {
    if (part.instrument.toLowerCase().includes('voice') || part.instrument.toLowerCase().includes('choir'))
      return 'choir_aahs';
  }
  if (part.program >= 52 && part.program <= 54) return 'choir_aahs';
  if (part.program >= 40 && part.program <= 41) return 'violin';
  if (part.program >= 42 && part.program <= 43) return 'cello';
  if (part.program >= 48 && part.program <= 51) return 'string_ensemble_1';
  if (part.program === 47) return 'timpani';
  if (part.program >= 24 && part.program <= 31) return 'acoustic_guitar_nylon';
  if (part.program >= 32 && part.program <= 39) return 'acoustic_bass';
  if (part.program === 57 || part.program === 58) return 'trombone';
  if (part.program === 60) return 'french_horn';
  if (part.program >= 56 && part.program <= 63) return 'trumpet';
  if (part.program >= 64 && part.program <= 67) return 'alto_sax';
  if (part.program === 68 || part.program === 69) return 'oboe';
  if (part.program === 70) return 'bassoon';
  if (part.program === 71) return 'clarinet';
  if (part.program >= 72 && part.program <= 79) return 'flute';
  if (part.program >= 16 && part.program <= 23) return 'church_organ';
  if (part.program >= 8 && part.program <= 10) return 'vibraphone';
  if (part.program === 11) return 'vibraphone';
  if (part.program === 12 || part.program === 13) return 'marimba';
  if (part.program === 14 || part.program === 15) return 'tubular_bells';
  if (part.program >= 80 && part.program <= 87) return 'lead_2_sawtooth';
  if (part.program >= 88 && part.program <= 99) return 'pad_2_warm';
  return 'acoustic_grand_piano';
}

export const sampleBankFor = bankFor;

export function metronomeGrid(project: Pick<ScoreProject, 'timeSignature'>): {
  step: number;
  measure: number;
} {
  const [numerator, denominator] = project.timeSignature;
  const measure = (numerator * 4) / denominator;
  const step = denominator === 8 && numerator > 3 && numerator % 3 === 0 ? 1.5 : 4 / denominator;
  return { step, measure };
}

export function normalizedLoop(project: ScoreProject, options: PlaybackOptions): PlaybackOptions {
  const total = project.measures * quarterBeats(project);
  const end = Math.max(0.001, Math.min(total, options.loopEnd));
  const start = Math.max(0, Math.min(end - 0.001, options.loopStart));
  return { ...options, loopStart: start, loopEnd: end };
}

export function sourceBeatLength(project: ScoreProject): number {
  const audio = project.originalAudio;
  return audio
    ? (Math.max(0.001, audio.duration - audio.offsetSeconds) * (audio.tempo ?? project.tempo)) / 60
    : project.measures * quarterBeats(project);
}

async function fetchBank(name: string): Promise<Bank> {
  if (!bankPromises.has(name))
    bankPromises.set(
      name,
      fetch(`/soundfonts/${name}.json`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`本地音色 ${name} 未找到，请检查安装。`);
          return (await response.json()) as Bank;
        })
        .catch((error) => {
          bankPromises.delete(name);
          throw error;
        }),
    );
  return bankPromises.get(name)!;
}

async function decodeSample(context: Context, bank: string, midi: number): Promise<AudioBuffer> {
  const key = `${context.sampleRate}:${bank}:${midi}`;
  const existing = sampleBuffers.get(key);
  if (existing) return existing;
  const samples = await fetchBank(bank);
  const name = nameForMidi(Math.max(21, Math.min(108, midi)));
  const data = samples[name];
  if (!data) throw new Error(`本地音色缺少 ${bank}/${name}`);
  const bytes = Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0));
  const decoded = await context.decodeAudioData(bytes.buffer);
  sampleBuffers.set(key, decoded);
  return decoded;
}

/** Distinct (bank, pitch) samples a project needs. With ``window`` only notes
 * sounding inside [from, to) beats are returned, in the order they first sound. */
export function sampleRequests(
  project: ScoreProject,
  window?: { from: number; to: number },
): Array<[string, number]> {
  const requests = new Map<string, { at: number; value: [string, number] }>();
  for (const part of project.parts) {
    if (part.role === 'percussion') continue;
    const bank = bankFor(part);
    for (const note of part.notes) {
      if (note.midi === null) continue;
      if (window && (note.start >= window.to || note.start + note.duration <= window.from)) continue;
      const key = `${bank}:${note.midi}`;
      const at = Math.max(note.start, window?.from ?? 0);
      const known = requests.get(key);
      if (!known || at < known.at) requests.set(key, { at, value: [bank, note.midi] });
    }
  }
  return [...requests.values()].sort((a, b) => a.at - b.at).map((entry) => entry.value);
}

async function decodeAll(context: Context, queue: Array<[string, number]>, workers = 8): Promise<void> {
  const pending = [...queue];
  await Promise.all(
    Array.from({ length: Math.min(workers, pending.length) }, async () => {
      while (pending.length) {
        const [bank, midi] = pending.shift()!;
        await decodeSample(context, bank, midi);
      }
    }),
  );
}

export async function prepareSamples(context: Context, project: ScoreProject): Promise<void> {
  await decodeAll(context, sampleRequests(project));
}

export function samplesReady(context: Context, project: ScoreProject): boolean {
  return sampleRequests(project).every(([bank, midi]) => sampleBuffers.has(`${context.sampleRate}:${bank}:${midi}`));
}

const noiseBuffers = new WeakMap<Context, AudioBuffer>();
function noise(context: Context): AudioBuffer {
  let buffer = noiseBuffers.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 123456789;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    noiseBuffers.set(context, buffer);
  }
  return buffer;
}

function percussion(
  context: Context,
  destination: AudioNode,
  midi: number,
  time: number,
  volume: number,
): AudioScheduledSourceNode[] {
  const gain = context.createGain();
  gain.connect(destination);
  const low = midi <= 36;
  const snare = [37, 38, 39, 40].includes(midi);
  if (low) {
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(135, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.16);
    gain.gain.setValueAtTime(Math.max(0.001, volume * 0.9), time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
    osc.connect(gain);
    osc.onended = () => gain.disconnect();
    osc.start(time);
    osc.stop(time + 0.23);
    return [osc];
  }
  const source = context.createBufferSource();
  source.buffer = noise(context);
  const filter = context.createBiquadFilter();
  filter.type = snare ? 'bandpass' : 'highpass';
  filter.frequency.value = snare ? 1700 : 7000;
  filter.Q.value = snare ? 0.7 : 0.4;
  source.connect(filter);
  filter.connect(gain);
  source.onended = () => {
    gain.disconnect();
    filter.disconnect();
  };
  const duration = snare ? 0.16 : midi === 46 ? 0.24 : 0.065;
  gain.gain.setValueAtTime(Math.max(0.001, volume * (snare ? 0.5 : 0.24)), time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  source.start(time);
  source.stop(time + duration + 0.01);
  return [source];
}

function scheduleNote(
  context: Context,
  destination: AudioNode,
  part: ScorePart,
  note: NoteEvent,
  time: number,
  duration: number,
  offsetSeconds = 0,
): AudioScheduledSourceNode[] {
  if (note.midi === null || duration <= 0) return [];
  const volume = notePlaybackLevel(note);
  if (volume <= 0) return [];
  if (part.role === 'percussion') return percussion(context, destination, note.midi, time, volume);
  const bank = bankFor(part);
  const buffer = sampleBuffers.get(`${context.sampleRate}:${bank}:${note.midi}`);
  if (!buffer) return [];
  const source = context.createBufferSource();
  source.buffer = buffer;
  const clamped = Math.max(21, Math.min(108, note.midi));
  source.playbackRate.value = Math.pow(2, (note.midi - clamped) / 12);
  const sustained = [
    'violin',
    'cello',
    'flute',
    'choir_aahs',
    'string_ensemble_1',
    'trumpet',
    'trombone',
    'french_horn',
    'clarinet',
    'oboe',
    'bassoon',
    'alto_sax',
    'church_organ',
    'lead_2_sawtooth',
    'pad_2_warm',
  ].includes(bank);
  if (sustained && buffer.duration > 0.8) {
    source.loop = true;
    source.loopStart = buffer.duration * 0.35;
    source.loopEnd = buffer.duration * 0.7;
  }
  const gain = context.createGain();
  const attack = sustained ? 0.045 : 0.005;
  const hold = Math.max(attack, duration * noteGateRatio(note) * (note.articulation === 'staccato' ? 1 : .94));
  const release = bank === 'acoustic_grand_piano' ? 0.2 : 0.09;
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(
    volume * (note.articulation === 'accent' ? 1.15 : 1),
    time + Math.min(attack, hold),
  );
  gain.gain.setValueAtTime(volume, time + hold);
  gain.gain.linearRampToValueAtTime(0, time + hold + release);
  source.connect(gain);
  gain.connect(destination);
  source.onended = () => gain.disconnect();
  const offset =
    sustained && offsetSeconds
      ? source.loopStart
      : Math.min(offsetSeconds, Math.max(0, buffer.duration - 0.05));
  source.start(time, offset);
  source.stop(time + hold + release + 0.01);
  return [source];
}

function click(
  context: Context,
  destination: AudioNode,
  time: number,
  accent: boolean,
): AudioScheduledSourceNode {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = 'sine';
  osc.frequency.value = accent ? 1600 : 1050;
  gain.gain.setValueAtTime(accent ? 0.32 : 0.21, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035);
  osc.connect(gain);
  gain.connect(destination);
  osc.onended = () => gain.disconnect();
  osc.start(time);
  osc.stop(time + 0.04);
  return osc;
}

export class PlaybackEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private analyser?: AnalyserNode;
  private meter = new Float32Array(256);
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private nodes = new Set<AudioScheduledSourceNode>();
  private partGains = new Map<string, GainNode>();
  private project?: ScoreProject;
  private events: Array<{ part: ScorePart; note: NoteEvent }> = [];
  private index = 0;
  private nextClick = 0;
  private anchorBeat = 0;
  private anchorTime = 0;
  private beat = 0;
  private playing = false;
  private options?: PlaybackOptions;
  private source?: HTMLAudioElement;
  private sourceNode?: MediaElementAudioSourceNode;
  private partPanners: StereoPannerNode[] = [];
  private listener?: (state: PlaybackState) => void;

  subscribe(listener: (state: PlaybackState) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  private emit() {
    let peak = 0;
    if (this.playing && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.meter);
      for (const n of this.meter) peak = Math.max(peak, Math.abs(n));
    }
    this.listener?.({ playing: this.playing, beat: this.beat, mode: this.options?.mode ?? 'score', peak });
  }
  private async ready() {
    // Safari can leave a context 'interrupted' (or closed) after an audio route
    // change, e.g. switching to AirPods; resume() then never produces sound.
    const state = this.context?.state as string | undefined;
    if (this.context && (state === 'closed' || state === 'interrupted')) {
      this.dropContext();
    }
    const context = this.context ?? this.createContext();
    if (context.state === 'suspended') await context.resume();
    return context;
  }
  private createContext(): AudioContext {
    const context = new AudioContext();
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0.64;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 14;
    compressor.ratio.value = 5;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.master.connect(compressor);
    compressor.connect(this.analyser);
    this.analyser.connect(context.destination);
    return context;
  }
  private dropContext() {
    this.sourceNode?.disconnect();
    this.sourceNode = undefined;
    for (const gain of this.partGains.values()) gain.disconnect();
    this.partGains.clear();
    this.partPanners.forEach((panner) => panner.disconnect());
    this.partPanners = [];
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.master = undefined;
    this.analyser = undefined;
  }
  /** Decode every sample of a project in the background (opening a score, or
   * after playback has started), so a later play or jump does not wait. */
  async warm(project: ScoreProject): Promise<void> {
    if (!this.context || this.context.state === 'closed') return;
    const context = this.context;
    if (samplesReady(context, project)) return;
    try {
      await decodeAll(context, sampleRequests(project, { from: this.beat, to: Infinity }), 4);
      await decodeAll(context, sampleRequests(project), 4);
    } catch {
      /* A missing bank surfaces as a play error; warming is best effort. */
    }
  }
  /** Create the audio context ahead of the first press (needs a user gesture
   * in Safari before it can run, but decoding works while suspended). */
  prime(project: ScoreProject) {
    if (!this.context) {
      try {
        this.createContext();
      } catch {
        return;
      }
    }
    void this.warm(project);
  }
  private track(nodes: AudioScheduledSourceNode[]) {
    for (const node of nodes) {
      this.nodes.add(node);
      const cleanup = node.onended;
      node.onended = (event) => {
        cleanup?.call(node, event);
        this.nodes.delete(node);
        node.disconnect();
      };
    }
  }
  async play(project: ScoreProject, options: PlaybackOptions): Promise<void> {
    this.pause();
    const errors = validateProject(project);
    if (errors.length) throw new Error(errors[0]);
    const generation = ++this.generation;
    const context = await this.ready();
    if (generation !== this.generation) return;
    this.project = project;
    options = normalizedLoop(project, options);
    this.options = options;
    const total =
      options.mode === 'source' ? sourceBeatLength(project) : project.measures * quarterBeats(project);
    this.beat = Math.max(0, Math.min(options.startBeat, Math.max(0, total - 0.01)));
    if (options.loop && (this.beat < options.loopStart || this.beat >= options.loopEnd))
      this.beat = options.loopStart;
    if (options.mode === 'source') {
      const url = options.sourceUrl ?? project.originalAudio?.url;
      if (!url) throw new Error('当前工程没有原始音频。请先导入音频，或生成示例试听。');
      this.sourceNode?.disconnect();
      const media = new Audio(url);
      this.source = media;
      media.preload = 'auto';
      this.sourceNode = context.createMediaElementSource(media);
      this.sourceNode.connect(this.master!);
      const sourceTempo = project.originalAudio?.tempo ?? project.tempo;
      if (project.tempo / sourceTempo < 0.25 || project.tempo / sourceTempo > 4)
        throw new Error('原音频变速支持原速的 0.25–4 倍。请调整速度，或改用谱曲播放。');
      media.currentTime = Math.max(
        0,
        (project.originalAudio?.offsetSeconds ?? 0) + (this.beat * 60) / sourceTempo,
      );
      media.playbackRate = project.tempo / sourceTempo;
      media.preservesPitch = true;
      await media.play();
      if (generation !== this.generation) {
        media.pause();
        return;
      }
    } else {
      // Only the opening seconds must be ready before the first note sounds.
      // Everything else keeps decoding while playback runs; the scheduler looks
      // 160 ms ahead, and a sample that is still decoding is skipped once rather
      // than delaying the whole start.
      const lead = (PLAYBACK_READY_SECONDS * project.tempo) / 60;
      await decodeAll(context, sampleRequests(project, { from: this.beat, to: this.beat + lead }));
      if (generation !== this.generation) return;
      void this.warm(project);
      for (const gain of this.partGains.values()) gain.disconnect();
      this.partPanners.forEach((panner) => panner.disconnect());
      this.partPanners = [];
      this.partGains.clear();
      for (const part of project.parts) {
        const gain = context.createGain();
        const panner = context.createStereoPanner();
        panner.pan.value = part.pan ?? 0;
        gain.connect(panner);
        panner.connect(this.master!);
        this.partGains.set(part.id, gain);
        this.partPanners.push(panner);
      }
      this.updateMixer(project.parts);
    }
    this.events = project.parts
      .flatMap((part) => performanceNotes(part, project.tempo).filter((note) => note.midi !== null).map((note) => ({ part, note })))
      .sort((a, b) => a.note.start - b.note.start);
    this.anchorBeat = this.beat;
    const preRoll = options.countIn && options.mode === 'score' ? quarterBeats(project) : 0;
    this.anchorTime = context.currentTime + 0.065 + (preRoll * 60) / project.tempo;
    if (preRoll)
      for (let i = 0; i < preRoll; i += metronomeGrid(project).step)
        this.track([
          click(context, this.master!, context.currentTime + 0.065 + (i * 60) / project.tempo, i === 0),
        ]);
    this.resetIndex();
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
    if (options.mode === 'score') void this.checkOutputClock(project, options, generation);
  }
  /** If the audio clock does not move after starting, the browser's audio
   * output is stuck (seen in Safari after a Bluetooth route change). Rebuild
   * the context once and restart from the same beat; report if that fails. */
  private async checkOutputClock(project: ScoreProject, options: PlaybackOptions, generation: number) {
    const context = this.context;
    if (!context) return;
    const before = context.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (generation !== this.generation || !this.playing || context !== this.context) return;
    if (context.currentTime - before > 0.05) {
      this.restartedForClock = false;
      return;
    }
    const beat = this.beat;
    this.pause();
    this.dropContext();
    if (this.restartedForClock) {
      this.restartedForClock = false;
      this.onOutputProblem?.('浏览器的音频输出没有在走，可能是耳机切换后浏览器音频卡住了。请刷新页面；若仍无声，重启浏览器。');
      return;
    }
    this.restartedForClock = true;
    await this.play(project, { ...options, startBeat: beat, countIn: false });
  }
  private restartedForClock = false;
  /** Called with a user-facing message when audio output cannot be recovered. */
  onOutputProblem?: (message: string) => void;
  private resetIndex() {
    this.index = this.events.findIndex(
      (event) => event.note.start + event.note.duration > this.anchorBeat + 1e-6,
    );
    if (this.index < 0) this.index = this.events.length;
    const step = this.project ? metronomeGrid(this.project).step : 1;
    this.nextClick = Math.ceil((this.anchorBeat - 1e-6) / step) * step;
  }
  private tick() {
    if (!this.playing || !this.context || !this.project || !this.options) return;
    const { context, project, options } = this;
    const secondsPerBeat = 60 / project.tempo;
    const total =
      options.mode === 'source' ? sourceBeatLength(project) : project.measures * quarterBeats(project);
    const clickGrid = metronomeGrid(project);
    const end = options.loop ? Math.min(total, options.loopEnd) : total;
    if (options.mode === 'source' && this.source) {
      const sourceTempo = project.originalAudio?.tempo ?? project.tempo;
      this.beat = Math.max(
        0,
        ((this.source.currentTime - (project.originalAudio?.offsetSeconds ?? 0)) * sourceTempo) / 60,
      );
      if (this.beat >= end || this.source.ended) {
        if (options.loop) {
          this.source.currentTime = Math.max(
            0,
            (project.originalAudio?.offsetSeconds ?? 0) + (options.loopStart * 60) / sourceTempo,
          );
          this.beat = options.loopStart;
          this.nextClick = Math.ceil(options.loopStart / clickGrid.step) * clickGrid.step;
          void this.source.play().catch(() => this.pause());
        } else {
          this.pause();
          this.beat = 0;
          this.emit();
          return;
        }
      }
      if (options.metronome && this.beat >= this.nextClick) {
        this.track([
          click(
            context,
            this.master!,
            context.currentTime + 0.003,
            this.nextClick % quarterBeats(project) < 0.01,
          ),
        ]);
        this.nextClick = (Math.floor(this.beat / clickGrid.step) + 1) * clickGrid.step;
      }
      this.emit();
      return;
    }
    const now = context.currentTime;
    this.beat = Math.max(this.anchorBeat, this.anchorBeat + (now - this.anchorTime) / secondsPerBeat);
    if (this.beat >= end) {
      if (!options.loop) {
        this.pause();
        this.beat = 0;
        this.emit();
        return;
      }
      this.anchorTime += (end - this.anchorBeat) * secondsPerBeat;
      this.anchorBeat = options.loopStart;
      this.beat = this.anchorBeat + Math.max(0, (now - this.anchorTime) / secondsPerBeat);
      this.resetIndex();
    }
    const horizon = this.anchorBeat + (now + 0.16 - this.anchorTime) / secondsPerBeat;
    while (this.index < this.events.length) {
      const { part, note } = this.events[this.index];
      if (note.start >= end || note.start > horizon) break;
      this.index++;
      const start = Math.max(note.start, this.anchorBeat);
      const noteEnd = Math.min(note.start + note.duration, end);
      if (noteEnd <= start) continue;
      const time = this.anchorTime + (start - this.anchorBeat) * secondsPerBeat;
      const lateness = Math.max(0, now - time);
      this.track(
        scheduleNote(
          context,
          this.partGains.get(part.id)!,
          part,
          note,
          Math.max(now, time),
          Math.max(0, (noteEnd - start) * secondsPerBeat - lateness),
          (start - note.start) * secondsPerBeat + lateness,
        ),
      );
    }
    if (options.metronome)
      while (this.nextClick <= horizon && this.nextClick < end) {
        const time = this.anchorTime + (this.nextClick - this.anchorBeat) * secondsPerBeat;
        if (time >= now - 0.015)
          this.track([
            click(context, this.master!, Math.max(now, time), this.nextClick % quarterBeats(project) < 0.01),
          ]);
        this.nextClick += clickGrid.step;
      }
    this.emit();
  }
  updateMixer(parts: ScorePart[]) {
    const solo = parts.some((part) => part.solo);
    for (const part of parts) {
      const gain = this.partGains.get(part.id);
      if (gain && this.context)
        gain.gain.setTargetAtTime(
          part.muted || (solo && !part.solo) ? 0 : part.volume,
          this.context.currentTime,
          0.015,
        );
    }
  }
  setMetronome(enabled: boolean) {
    if (this.options) this.options.metronome = enabled;
    const step = this.project ? metronomeGrid(this.project).step : 1;
    this.nextClick = Math.ceil(this.beat / step) * step;
  }
  pause() {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const source of this.nodes) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        /* Already ended. */
      }
    }
    this.nodes.clear();
    this.source?.pause();
    this.playing = false;
    this.emit();
  }
  seek(beat: number) {
    this.pause();
    this.beat = Math.max(0, beat);
    this.emit();
  }
  async audition(part: ScorePart, midi: number) {
    const context = await this.ready();
    if (part.role !== 'percussion') await decodeSample(context, bankFor(part), midi);
    this.track(
      scheduleNote(
        context,
        this.master!,
        part,
        { id: 'preview', midi, start: 0, duration: 1, velocity: 0.6 },
        context.currentTime + 0.01,
        0.45,
      ),
    );
  }
  dispose() {
    this.pause();
    this.sourceNode?.disconnect();
    for (const gain of this.partGains.values()) gain.disconnect();
    this.partPanners.forEach((panner) => panner.disconnect());
    void this.context?.close();
    this.listener = undefined;
  }
}

export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const channels = buffer.numberOfChannels;
  const dataLength = buffer.length * channels * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataLength, true);
  const channelData = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  for (let frame = 0; frame < buffer.length; frame++)
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.max(-1, Math.min(1, channelData[channel][frame]));
      view.setInt16(44 + (frame * channels + channel) * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
  return bytes;
}

export async function renderProjectAudio(
  project: ScoreProject,
  partIds?: string[],
): Promise<{ bytes: Uint8Array; buffer: AudioBuffer }> {
  const errors = validateProject(project);
  if (errors.length) throw new Error(errors[0]);
  const duration = (project.measures * quarterBeats(project) * 60) / project.tempo + 0.75;
  if (duration > 1200) throw new Error('离线音频导出最多支持 20 分钟，请先裁减工程。');
  const context = new OfflineAudioContext(2, Math.ceil(duration * 44100), 44100);
  const selected = {
    ...project,
    parts: project.parts.filter((part) => !partIds || partIds.includes(part.id)),
  };
  if (!selected.parts.length) throw new Error('请至少选择一个声部。');
  await prepareSamples(context, selected);
  const master = context.createGain();
  master.gain.value = 0.64;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.ratio.value = 5;
  master.connect(compressor);
  compressor.connect(context.destination);
  for (const part of selected.parts) {
    const gain = context.createGain();
    gain.gain.value = part.volume;
    const panner = context.createStereoPanner();
    panner.pan.value = part.pan ?? 0;
    gain.connect(panner);
    panner.connect(master);
    for (const note of performanceNotes(part, project.tempo))
      scheduleNote(
        context,
        gain,
        part,
        note,
        (note.start * 60) / project.tempo + 0.015,
        (note.duration * 60) / project.tempo,
      );
  }
  const buffer = await context.startRendering();
  return { bytes: encodeWav(buffer), buffer };
}

export function waveformPeaks(buffer: AudioBuffer, count = 400): number[] {
  const channel = buffer.getChannelData(0);
  const stride = Math.max(1, Math.floor(channel.length / count));
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    let peak = 0;
    for (
      let j = i * stride;
      j < Math.min((i + 1) * stride, channel.length);
      j += Math.max(1, Math.floor(stride / 100))
    )
      peak = Math.max(peak, Math.abs(channel[j]));
    peaks.push(peak);
  }
  const max = Math.max(0.01, ...peaks);
  return peaks.map((value) => value / max);
}

export async function readWaveform(url: string): Promise<number[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法读取原始音频。');
  const context = new OfflineAudioContext(1, 1, 22050);
  return waveformPeaks(await context.decodeAudioData(await response.arrayBuffer()));
}
