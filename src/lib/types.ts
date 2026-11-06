export type PartRole = 'lead' | 'harmony' | 'bass' | 'percussion' | 'instrument';
export type Clef = 'treble' | 'bass' | 'alto' | 'percussion';
export type NoteOrigin = 'transcribed' | 'arranged' | 'manual' | 'demo';

export interface NoteEvent {
  id: string;
  midi: number | null;
  start: number;
  duration: number;
  velocity: number;
  lyric?: string;
  confidence?: number;
  origin?: NoteOrigin;
  articulation?: 'staccato' | 'accent' | 'tenuto';
  dynamic?: 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff';
  dynamicScope?: 'staff' | 'voice';
  staff?: number;
  voice?: string;
}

export interface ScorePart {
  id: string;
  name: string;
  shortName: string;
  instrument: string;
  role: PartRole;
  roleSource?: 'manual' | 'model';
  clef: Clef;
  program: number;
  color: string;
  notes: NoteEvent[];
  muted: boolean;
  solo: boolean;
  volume: number;
  pan?: number;
  range?: [number, number];
  stemUrl?: string;
  staves?: Array<{ number: number; clef: Clef }>;
}

export interface ChordEvent {
  start: number;
  duration: number;
  symbol: string;
  pitches: number[];
  confidence?: number;
}

export interface SourceInfo {
  kind: 'demo' | 'audio' | 'midi' | 'musicxml' | 'manual' | 'omr';
  filename?: string;
  engine?: string;
  warnings: string[];
  detectedInstruments?: Array<{ name: string; confidence: number; method: string }>;
  analysis?: {
    rhythm?: {
      bpm: number;
      offsetSeconds: number;
      beatTimesSeconds?: number[];
      downbeatTimesSeconds?: number[];
      method: string;
      confidence?: number;
    };
    transforms: string[];
    rawProjectUrl?: string;
    quality?: Record<string, number | string | boolean | null>;
    uncertaintyIntervals?: Array<{
      partId: string;
      startSeconds: number;
      endSeconds: number;
      reason: string;
      alternatives?: string[];
    }>;
  };
  pages?: string[];
  analysisStartSeconds?: number;
}

export interface ArrangementOptions {
  preset: 'satb' | 'ssaa' | 'ttbb';
  style: 'pop' | 'choral' | 'jazz';
  difficulty: 'easy' | 'medium' | 'advanced';
  percussion: boolean;
  transpose: number;
  leadPartId?: string;
}

export interface ArrangementReport {
  warnings: string[];
  changes: string[];
  ranges: Array<{ partId: string; low: number; high: number; violations: number }>;
  breathing?: Array<{
    partId: string;
    longestPhraseSeconds: number;
    phrasesOverTarget: number;
    targetSeconds: number;
    minimumBreathSeconds: number;
    plannedGaps?: Array<{ startBeat: number; resumeBeat: number; sourceNoteId: string; split: boolean }>;
  }>;
}

export interface ScoreProject {
  version: 1;
  id: string;
  title: string;
  composer: string;
  tempo: number;
  timeSignature: [number, number];
  key: string;
  measures: number;
  parts: ScorePart[];
  chords: ChordEvent[];
  source: SourceInfo;
  originalAudio?: {
    name: string;
    url: string;
    fileUrl?: string;
    duration: number;
    offsetSeconds: number;
    tempo?: number;
  };
  arrangement?: { options: ArrangementOptions; report: ArrangementReport };
  createdAt: string;
  updatedAt: string;
}

export interface AbcRenderResult {
  abc: string;
  noteMap: Record<number, { partId: string; noteId: string }>;
  /** Silent, timed chord-annotation lane, included in staffMap for ABC track mapping. */
  harmonyVoiceId?: string;
  staffMap?: Array<{ partId: string; staffNumber: number; clef: Clef; voiceIds: string[] }>;
  systemMeasures?: number[];
  warnings?: string[];
  noteSegments?: Record<
    number,
    { partId: string; noteIds: string[]; start: number; duration: number; midiPitches?: number[] }
  >;
}

export interface OmrJob {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  message: string;
  error?: string;
  musicxml?: string;
  warnings?: string[];
  pages?: number;
  source?: { filename: string; engine: string };
  downloadUrl?: string;
  pageUrls?: string[];
  statistics?: Record<string, number | string | boolean | null>;
}

export interface AnalysisJob {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  message: string;
  error?: string;
  project?: ScoreProject;
}
