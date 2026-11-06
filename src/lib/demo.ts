import type { ChordEvent, NoteEvent, ScorePart, ScoreProject } from './types';
import { newId } from './music';

function makePart(
  id: string,
  name: string,
  shortName: string,
  instrument: string,
  program: number,
  color: string,
  role: ScorePart['role'],
  clef: ScorePart['clef'],
  volume: number,
  pan: number,
): ScorePart {
  return {
    id,
    name,
    shortName,
    instrument,
    program,
    color,
    role,
    clef,
    volume,
    pan,
    notes: [],
    muted: false,
    solo: false,
  };
}

export function createBlankProject(): ScoreProject {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: newId('project'),
    title: '未命名乐谱',
    composer: '',
    tempo: 100,
    timeSignature: [4, 4],
    key: 'C',
    measures: 8,
    parts: [
      makePart('piano', '钢琴', 'Pno.', 'acoustic_grand_piano', 0, '#b35c42', 'lead', 'treble', 0.8, 0),
    ],
    chords: [],
    source: { kind: 'manual', warnings: [] },
    createdAt: now,
    updatedAt: now,
  };
}

export function createDemoProject(): ScoreProject {
  const now = new Date().toISOString();
  const flute = makePart(
    'flute',
    '长笛 · 主旋律',
    'Fl.',
    'flute',
    73,
    '#bd6b4e',
    'lead',
    'treble',
    0.84,
    -0.08,
  );
  const piano = makePart(
    'piano',
    '钢琴 · 和声',
    'Pno.',
    'acoustic_grand_piano',
    0,
    '#667d69',
    'harmony',
    'treble',
    0.58,
    -0.3,
  );
  const cello = makePart('cello', '大提琴 · 低音', 'Vc.', 'cello', 42, '#567c94', 'bass', 'bass', 0.66, 0.16);
  const guitar = makePart(
    'guitar',
    '尼龙吉他 · 律动',
    'Gtr.',
    'acoustic_guitar_nylon',
    24,
    '#a38950',
    'instrument',
    'treble',
    0.48,
    0.36,
  );
  const percussion = makePart(
    'drums',
    '打击乐',
    'Perc.',
    'standard_drum_kit',
    0,
    '#8a7890',
    'percussion',
    'percussion',
    0.47,
    0.06,
  );
  const bars: Array<{
    symbol: string;
    pitches: number[];
    bass: number;
    melody: Array<[number | null, number]>;
  }> = [
    {
      symbol: 'Fmaj7',
      pitches: [53, 57, 60, 64],
      bass: 41,
      melody: [
        [69, 1],
        [72, 0.5],
        [74, 0.5],
        [72, 1],
        [69, 1],
      ],
    },
    {
      symbol: 'C/E',
      pitches: [52, 55, 60, 64],
      bass: 40,
      melody: [
        [67, 1.5],
        [64, 0.5],
        [67, 1.5],
        [69, 0.5],
      ],
    },
    {
      symbol: 'Dm7',
      pitches: [50, 53, 57, 60],
      bass: 38,
      melody: [
        [65, 1],
        [69, 1],
        [72, 1],
        [69, 0.5],
        [67, 0.5],
      ],
    },
    {
      symbol: 'Bbmaj7',
      pitches: [46, 50, 53, 57],
      bass: 46,
      melody: [
        [65, 2],
        [62, 1.5],
        [null, 0.5],
      ],
    },
    {
      symbol: 'Gm7',
      pitches: [43, 46, 50, 53],
      bass: 43,
      melody: [
        [67, 0.5],
        [69, 0.5],
        [70, 1],
        [74, 1],
        [72, 1],
      ],
    },
    {
      symbol: 'Csus4',
      pitches: [48, 53, 55, 60],
      bass: 36,
      melody: [
        [72, 1.5],
        [70, 0.5],
        [69, 1],
        [67, 1],
      ],
    },
    {
      symbol: 'F/A',
      pitches: [45, 53, 57, 60],
      bass: 45,
      melody: [
        [69, 1],
        [65, 0.5],
        [67, 0.5],
        [69, 1],
        [72, 1],
      ],
    },
    {
      symbol: 'C7',
      pitches: [48, 52, 55, 58],
      bass: 36,
      melody: [
        [67, 2],
        [64, 1.5],
        [null, 0.5],
      ],
    },
    {
      symbol: 'Fmaj7',
      pitches: [53, 57, 60, 64],
      bass: 41,
      melody: [
        [72, 1],
        [76, 1],
        [77, 0.5],
        [76, 0.5],
        [72, 1],
      ],
    },
    {
      symbol: 'Am7',
      pitches: [45, 48, 52, 55],
      bass: 45,
      melody: [
        [72, 1.5],
        [69, 0.5],
        [67, 1],
        [64, 1],
      ],
    },
    {
      symbol: 'Dm7',
      pitches: [50, 53, 57, 60],
      bass: 38,
      melody: [
        [69, 0.5],
        [72, 0.5],
        [74, 1.5],
        [72, 0.5],
        [69, 1],
      ],
    },
    {
      symbol: 'Bbmaj7',
      pitches: [46, 50, 53, 57],
      bass: 46,
      melody: [
        [70, 2],
        [69, 1],
        [65, 0.5],
        [null, 0.5],
      ],
    },
    {
      symbol: 'Gm7',
      pitches: [43, 46, 50, 53],
      bass: 43,
      melody: [
        [67, 1],
        [70, 1],
        [74, 1],
        [72, 1],
      ],
    },
    {
      symbol: 'C7',
      pitches: [48, 52, 55, 58],
      bass: 36,
      melody: [
        [70, 1],
        [69, 1],
        [67, 1],
        [64, 1],
      ],
    },
    {
      symbol: 'F',
      pitches: [53, 57, 60],
      bass: 41,
      melody: [
        [65, 2],
        [69, 1],
        [67, 1],
      ],
    },
    {
      symbol: 'F',
      pitches: [53, 57, 60],
      bass: 41,
      melody: [
        [65, 3.5],
        [null, 0.5],
      ],
    },
  ];
  let serial = 0;
  const add = (
    part: ScorePart,
    midi: number | null,
    start: number,
    duration: number,
    velocity: number,
    extra: Partial<NoteEvent> = {},
  ) => {
    part.notes.push({ id: `demo-${++serial}`, midi, start, duration, velocity, origin: 'demo', ...extra });
  };
  const chords: ChordEvent[] = [];
  bars.forEach((bar, index) => {
    const start = index * 4;
    chords.push({ start, duration: 4, symbol: bar.symbol, pitches: bar.pitches });
    let cursor = start;
    bar.melody.forEach(([midi, duration], noteIndex) => {
      add(
        flute,
        midi,
        cursor,
        duration,
        index >= 8 && index < 14 ? 0.84 : 0.75,
        noteIndex === 0 && index % 4 === 0 ? { dynamic: index === 8 ? 'mf' : 'mp' } : {},
      );
      cursor += duration;
    });
    const upper = bar.pitches.slice(-3).map((pitch) => (pitch < 55 ? pitch + 12 : pitch));
    upper.forEach((pitch) => {
      add(piano, pitch, start, index === 15 ? 3.5 : 1.5, 0.64, index === 0 ? { dynamic: 'mp' } : {});
      if (index !== 15) add(piano, pitch, start + 2.5, 1, 0.52);
    });
    add(cello, bar.bass, start, index === 15 ? 3.5 : 2, 0.76, index === 0 ? { dynamic: 'mp' } : {});
    if (index !== 15) add(cello, bar.bass + 7, start + 2, 1.75, 0.66);
    const figure = [upper[0], upper[1], upper[2], upper[1]];
    figure.forEach((pitch, noteIndex) => {
      if (index !== 15 || noteIndex < 2)
        add(guitar, pitch, start + 0.5 + noteIndex, 0.5, noteIndex % 2 ? 0.47 : 0.54, {
          articulation: 'staccato',
        });
    });
    if (index === 15) {
      add(percussion, 36, start, 0.25, 0.58);
      return;
    }
    add(percussion, 36, start, 0.5, 0.7);
    add(percussion, 42, start + 0.5, 0.5, 0.42);
    add(percussion, 38, start + 1, 0.5, 0.65);
    add(percussion, 42, start + 1.5, 0.5, 0.4);
    add(percussion, 36, start + 2, 0.5, 0.64);
    add(percussion, 42, start + 2.5, 0.5, 0.44);
    add(percussion, 38, start + 3, 0.5, 0.67);
    add(percussion, 42, start + 3.5, 0.5, 0.38);
  });
  return {
    version: 1,
    id: 'blue-hour-original',
    title: 'Blue Hour / 薄暮',
    composer: 'Coro 原创示例',
    tempo: 92,
    timeSignature: [4, 4],
    key: 'F',
    measures: 16,
    parts: [flute, piano, cello, guitar, percussion],
    chords,
    source: {
      kind: 'demo',
      engine: 'Coro original symbolic composition',
      warnings: ['原创合成示例：音轨与乐谱来自同一组音符，用于体验工作流，不代表上传音频的识别准确率。'],
    },
    createdAt: now,
    updatedAt: now,
  };
}
