import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import { parseMidi } from 'midi-file';
import { XMLParser } from 'fast-xml-parser';
import { createBlankProject, createDemoProject } from '../src/lib/demo';
import {
  beatsPerBar,
  fromMidi,
  fromMusicXml,
  pitchName,
  toAbc,
  toMidi,
  toMusicXml,
  transposeKey,
  validateProject,
} from '../src/lib/music';
import type { NoteEvent, ScoreProject } from '../src/lib/types';

const midiBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const actualNotes = (project: ScoreProject) =>
  project.parts.map((part) =>
    part.notes
      .filter((note) => note.midi !== null)
      .map((note) => [note.midi, Number(note.start.toFixed(5)), Number(note.duration.toFixed(5))])
      .sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!),
  );
const note = (
  id: string,
  midi: number | null,
  start: number,
  duration: number,
  extra: Partial<NoteEvent> = {},
): NoteEvent => ({ id, midi, start, duration, velocity: 0.8, origin: 'manual', ...extra });

describe('symbolic score contract', () => {
  it('keeps fractional invisible voice spacers exact without unrenderable tuplet anchors', () => {
    const project = createBlankProject();
    project.parts[0].notes = [note('held', 60, 0, 4, { voice: '1' }), note('enter', 64, 1 / 3, 1 / 3, { voice: '2' })];
    project.chords = [{ start: 1 / 3, duration: 1, symbol: 'C', pitches: [60, 64, 67] }];
    const result = toAbc(project);
    expect(result.abc).not.toMatch(/\(\d+:\d+:1x/);
    const tune = abcjs.parseOnly(result.abc)[0];
    expect(((tune as unknown as { warnings?: string[] }).warnings ?? []).filter((w) => !w.includes('Duration not representable'))).toEqual([]);
    const audio = tune.setUpAudio({ chordsOff: true });
    expect(audio.tracks.flat().filter((e) => e.cmd === 'note')).toHaveLength(2);
  });
  it('creates a valid original 16-bar demo, not a transcription result', () => {
    const demo = createDemoProject();
    expect(validateProject(demo)).toEqual([]);
    expect(demo.measures).toBe(16);
    expect(demo.parts).toHaveLength(5);
    expect(demo.source.kind).toBe('demo');
    expect(demo.parts.every((part) => part.notes.every((event) => event.origin === 'demo'))).toBe(true);
    expect(demo.chords).toHaveLength(16);
  });

  it('validates bad IDs, time, velocity, pitches, and bar overflow', () => {
    const project = createBlankProject();
    project.parts[0].notes = [note('a', 128, 0, 1)];
    expect(validateProject(project).join('')).toContain('音高');
    project.parts[0].notes = [note('a', 60, 31, 2)];
    expect(validateProject(project).join('')).toContain('小节边界');
    project.parts[0].notes = [note('a', 60, 0, 1), note('a', 62, 1, 1)];
    expect(validateProject(project).join('')).toContain('编号');
    project.parts[0].notes = [note('a', 60, 0, 1, { velocity: NaN })];
    expect(validateProject(project).join('')).toContain('力度');
  });

  it('uses quarter-note beat units in compound time', () => {
    expect(beatsPerBar({ timeSignature: [6, 8] })).toBe(3);
    expect(pitchName(60)).toBe('C4');
    expect(pitchName(69)).toBe('A4');
    expect(transposeKey('F', -2)).toBe('Eb');
    expect(transposeKey('Am', 2)).toBe('Bm');
  });

  it('rejects invalid optional and metadata fields without crashing the validator', () => {
    const source = createDemoProject();
    const baseNote = source.parts[0].notes[0];
    const variants: unknown[] = [
      { ...source, composer: {} },
      { ...source, key: 7 },
      { ...source, key: 'not-a-key' },
      { ...source, source: { ...source.source, warnings: [{}] } },
      {
        ...source,
        source: {
          ...source.source,
          detectedInstruments: [{ name: 'Flute', confidence: NaN, method: 'fixture' }],
        },
      },
      { ...source, originalAudio: { name: 'bad', url: {}, duration: 2, offsetSeconds: 0 } },
      {
        ...source,
        originalAudio: { name: 'bad', url: '/api/audio/a/b.wav', duration: Infinity, offsetSeconds: 0 },
      },
      { ...source, arrangement: { options: {}, report: { warnings: [{}], changes: [], ranges: [] } } },
      ...[
        { instrument: 7 },
        { role: 'unknown' },
        { roleSource: 'mystery' },
        { color: {} },
        { pan: NaN },
        { pan: 2 },
        { range: [72, 48] },
        { range: [48, '72'] },
        { muted: 'false' },
        { stemUrl: {} },
      ].map((patch) => ({ ...source, parts: [{ ...source.parts[0], ...patch }] })),
      ...[
        { lyric: {} },
        { confidence: NaN },
        { confidence: 1.2 },
        { origin: 'mystery' },
        { dynamic: 'fff' },
        { articulation: 'unsupported' },
      ].map((patch) => ({ ...source, parts: [{ ...source.parts[0], notes: [{ ...baseNote, ...patch }] }] })),
    ];
    variants.forEach((variant, index) => {
      expect(() => validateProject(variant as ScoreProject), `variant ${index}`).not.toThrow();
      expect(validateProject(variant as ScoreProject).length, `variant ${index}`).toBeGreaterThan(0);
      expect(() => toAbc(variant as ScoreProject), `variant ${index}`).toThrow();
    });
  });

  it('accepts old valid demos, optional-field omission and per-part duplicate note IDs', () => {
    const source = createDemoProject();
    delete source.parts[0].pan;
    delete source.parts[0].range;
    delete source.parts[0].notes[0].lyric;
    delete source.parts[0].notes[0].confidence;
    source.parts[1].notes[0].id = source.parts[0].notes[0].id;
    expect(validateProject(source)).toEqual([]);
  });
});

describe('ABC engraving and selection map', () => {
  it('parses the entire demo without ABC syntax errors', () => {
    const { abc, noteMap } = toAbc(createDemoProject());
    const tunes = abcjs.parseOnly(abc);
    expect(tunes).toHaveLength(1);
    expect((tunes[0] as unknown as { warnings?: string[] }).warnings ?? []).toEqual([]);
    expect(abc).toContain('K:F');
    expect(abc).toContain('V:P5V1 clef=perc');
    expect(Object.keys(noteMap).length).toBeGreaterThan(300);
  });

  it('preserves a sustained note across barlines and maps both segments', () => {
    const project = createBlankProject();
    project.measures = 2;
    project.parts[0].notes = [note('held', 60, 3, 3, { lyric: 'ah', dynamic: 'mp' })];
    const result = toAbc(project);
    expect(result.abc).toMatch(/C2-/);
    expect(result.abc).toMatch(/C4/);
    const heldSegments = Object.entries(result.noteMap).filter(
      ([index, mapping]) => mapping.noteId === 'held' && result.abc[Number(index)] === 'C',
    );
    expect(heldSegments).toHaveLength(2);
    expect(result.abc).toContain('w:ah | * |');
    expect((abcjs.parseOnly(result.abc)[0] as unknown as { warnings?: string[] }).warnings ?? []).toEqual([]);
  });

  it('encodes simultaneous same-duration chord notes without serializing them', () => {
    const project = createBlankProject();
    project.measures = 1;
    project.parts[0].notes = [note('c', 60, 0, 4), note('e', 64, 0, 4), note('g', 67, 0, 4)];
    const result = toAbc(project);
    expect(result.abc).toMatch(/\[GEC\]8/);
    expect(new Set(Object.values(result.noteMap).map((item) => item.noteId))).toEqual(
      new Set(['c', 'e', 'g']),
    );
  });

  it('keeps overlapping unequal durations in separate voices on the same staff', () => {
    const project = createBlankProject();
    project.measures = 1;
    project.parts[0].notes = [note('low', 48, 0, 4), note('high', 72, 0, 1), note('high2', 74, 1, 1)];
    const result = toAbc(project);
    expect(result.abc).toContain('%%score [ ( P1V1 P1V2 ) ]');
    expect((abcjs.parseOnly(result.abc)[0] as unknown as { warnings?: string[] }).warnings ?? []).toEqual([]);
  });

  it('escapes score header newlines and natural accidentals in a key signature', () => {
    const project = createBlankProject();
    project.measures = 1;
    project.title = 'Test\nK:D';
    project.key = 'G';
    project.parts[0].notes = [note('fsharp', 66, 0, 1), note('f', 65, 1, 1), note('fsharp2', 66, 2, 1)];
    const { abc } = toAbc(project);
    expect(abc).toContain('T:Test K:D\n');
    expect(abc).toContain('F2 =F2 ^F2');
  });

  it('independently decodes ABC to the source note pitches and beat times, including percussion', () => {
    const source = createDemoProject();
    const { abc, staffMap } = toAbc(source);
    const decoded = abcjs.parseOnly(abc)[0].setUpAudio({ chordsOff: true });
    const trackParts = staffMap!.flatMap((staff) => staff.voiceIds.map(() => staff.partId));
    expect(decoded.totalDuration * 4).toBeCloseTo(64, 6);
    source.parts.forEach((part) => {
      const actual = decoded.tracks.flatMap((track, index) => trackParts[index] === part.id ? track : [])
        .filter((event) => event.cmd === 'note')
        .map((event) => [
          event.pitch,
          Number((event.start * 4).toFixed(5)),
          Number((event.duration * 4).toFixed(5)),
        ])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const expected = part.notes
        .filter((note) => note.midi !== null)
        .map((note) => [note.midi!, note.start, note.duration])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      expect(actual, part.name).toEqual(expected);
    });
  });

  it('splits awkward quantized durations into tied glyphs without changing pitch or time', () => {
    const source = createBlankProject();
    source.measures = 3;
    source.parts[0].notes = [note('a', 60, 0.25, 1.25), note('b', 64, 1.75, 2.5), note('c', 67, 7.25, 2.75)];
    const { abc } = toAbc(source);
    const tune = abcjs.parseOnly(abc)[0];
    expect(tune.warnings ?? []).toEqual([]);
    const pitches = tune
      .setUpAudio({ chordsOff: true })
      .tracks.flat()
      .filter((event) => event.cmd === 'note');
    expect(pitches.map((event) => [event.pitch, event.start * 4, event.duration * 4])).toEqual(
      source.parts[0].notes.map((event) => [event.midi, event.start, event.duration]),
    );
  });

  it('preserves eighth-note triplets in rendered notation with explicit tuplets', () => {
    const source = createBlankProject();
    source.measures = 1;
    source.parts[0].notes = [
      note('a', 60, 0, 1 / 3),
      note('b', 62, 1 / 3, 1 / 3),
      note('c', 64, 2 / 3, 1 / 3),
    ];
    const { abc } = toAbc(source);
    expect(abc).toContain('(3:2:3');
    const tune = abcjs.parseOnly(abc)[0];
    expect(tune.warnings ?? []).toEqual([]);
    const pitches = tune
      .setUpAudio({ chordsOff: true })
      .tracks.flat()
      .filter((event) => event.cmd === 'note');
    pitches.forEach((event, index) => {
      expect(event.start * 4).toBeCloseTo(index / 3, 4);
      expect(event.duration * 4).toBeCloseTo(1 / 3, 4);
    });
  });

  it('maps all standard GM drum notes without collisions in the ABC percussion staff', () => {
    const source = createBlankProject();
    source.measures = 12;
    source.parts[0].role = 'percussion';
    source.parts[0].clef = 'percussion';
    source.parts[0].notes = Array.from({ length: 47 }, (_, index) =>
      note(`drum-${index}`, 35 + index, index, 0.5),
    );
    const tune = abcjs.parseOnly(toAbc(source).abc)[0];
    expect(tune.warnings ?? []).toEqual([]);
    expect(
      tune
        .setUpAudio({ chordsOff: true })
        .tracks.flat()
        .filter((event) => event.cmd === 'note')
        .map((event) => event.pitch),
    ).toEqual(source.parts[0].notes.map((note) => note.midi));
  });

  it('shows harmony changes inside held notes without splitting the held note', () => {
    const source = createBlankProject();
    source.measures = 1;
    source.parts[0].notes = [note('held', 60, 0, 4)];
    source.chords = [
      { start: 0, duration: 2, symbol: 'C', pitches: [48, 52, 55] },
      { start: 2, duration: 2, symbol: 'F', pitches: [53, 57, 60] },
    ];
    const { abc } = toAbc(source);
    expect(abc).toContain('C8');
    expect(abc).toContain('"C"x4 "F"x4');
    const tune = abcjs.parseOnly(abc)[0];
    expect(tune.warnings ?? []).toEqual([]);
    const decoded = tune
      .setUpAudio({ chordsOff: true })
      .tracks.flat()
      .filter((event) => event.cmd === 'note');
    expect(decoded).toHaveLength(1);
    expect(decoded[0].duration * 4).toBe(4);
  });

  it('maps every abcjs note startChar, including whitespace before dynamics and bar chords', () => {
    const source = createDemoProject();
    const { abc, noteMap } = toAbc(source);
    const tune = abcjs.parseOnly(abc)[0];
    const elements = tune.lines
      .flatMap((line) => (line.staff ?? []).flatMap((staff) => (staff.voices ?? []).flat()))
      .filter((element) => element && element.el_type === 'note' && 'pitches' in element && element.pitches);
    expect(elements.length).toBeGreaterThan(300);
    elements.forEach((element) => {
      const position = (element as { startChar: number }).startChar;
      expect(noteMap[position], `unmapped ${abc.slice(position, position + 25)}`).toBeDefined();
      expect(
        source.parts
          .find((part) => part.id === noteMap[position].partId)
          ?.notes.some((note) => note.id === noteMap[position].noteId),
      ).toBe(true);
    });
  });

  it('changes system layout for mobile without changing any sounding note', () => {
    const source = createDemoProject();
    const standard = abcjs.parseOnly(toAbc(source).abc)[0];
    const compact = abcjs.parseOnly(
      toAbc(source, undefined, { barsPerSystem: 2, staffSep: 34, systemSep: 44 }).abc,
    )[0];
    expect(compact.lines.filter((line) => line.staff)).toHaveLength(8);
    expect(standard.lines.filter((line) => line.staff)).toHaveLength(4);
    const fingerprint = (tune: typeof standard) =>
      tune
        .setUpAudio({ chordsOff: true })
        .tracks.map((track) =>
          track
            .filter((event) => event.cmd === 'note')
            .map((event) => [event.pitch, event.start, event.duration]),
        );
    expect(fingerprint(compact)).toEqual(fingerprint(standard));
    expect(compact.warnings ?? []).toEqual([]);
  });

  it('keeps percussion staves keyless across all systems without altering melodic keys or drum pitches', () => {
    const source = createDemoProject();
    source.key = 'D';
    const result = toAbc(source);
    const tune = abcjs.parseOnly(result.abc)[0];
    const systems = tune.lines.filter((line) => line.staff);
    expect(systems).toHaveLength(4);
    systems.forEach((system) => {
      system.staff!.forEach((staff, index) => {
        if (source.parts[index].role === 'percussion') expect(staff.key?.accidentals ?? []).toEqual([]);
        else expect(staff.key?.accidentals).toHaveLength(2);
      });
    });
    const audio = tune.setUpAudio({ chordsOff: true });
    const trackParts = result.staffMap!.flatMap((staff) => staff.voiceIds.map(() => staff.partId));
    source.parts.forEach((part) => {
      const pitches = audio.tracks.flatMap((track, index) => trackParts[index] === part.id ? track : [])
        .filter((event) => event.cmd === 'note')
        .map((event) => event.pitch)
        .sort((a, b) => a - b);
      expect(pitches).toEqual(
        part.notes
          .filter((note) => note.midi !== null)
          .map((note) => note.midi!)
          .sort((a, b) => a - b),
      );
    });
    const xml = new XMLParser({ ignoreAttributes: false }).parse(toMusicXml(source));
    const drums = xml['score-partwise'].part.at(-1).measure[0].attributes.key;
    expect(drums).toMatchObject({ fifths: 0, '@_print-object': 'no' });
    expect(xml['score-partwise'].part[0].measure[0].attributes.key.fifths).toBe(2);
    expect(fromMusicXml(toMusicXml(source)).source.warnings.join('')).not.toContain('调号变化');
  });
});

describe('MusicXML interchange', () => {
  it('roundtrips demo pitches, absolute times, chords, drums, names and tempo', () => {
    const source = createDemoProject();
    const xml = toMusicXml(source);
    const restored = fromMusicXml(xml);
    expect(validateProject(restored)).toEqual([]);
    expect(restored.title).toBe(source.title);
    expect(restored.composer).toBe(source.composer);
    expect(restored.tempo).toBe(source.tempo);
    expect(restored.key).toBe(source.key);
    expect(restored.measures).toBe(source.measures);
    expect(restored.parts.map((part) => part.name)).toEqual(source.parts.map((part) => part.name));
    expect(actualNotes(restored)).toEqual(actualNotes(source));
    expect(restored.chords.map((chord) => chord.symbol)).toEqual(source.chords.map((chord) => chord.symbol));
    expect(restored.parts[4].role).toBe('percussion');
  });

  it('joins ties through multiple measures and retains lyrics, dynamics and articulations', () => {
    const source = createBlankProject();
    source.measures = 3;
    source.parts[0].notes = [
      note('long', 61, 1.5, 9.5, { lyric: 'one & <two>', dynamic: 'mf', articulation: 'tenuto' }),
    ];
    const restored = fromMusicXml(toMusicXml(source));
    const pitched = restored.parts[0].notes.filter((note) => note.midi !== null);
    expect(pitched).toHaveLength(1);
    expect(pitched[0]).toMatchObject({
      midi: 61,
      start: 1.5,
      duration: 9.5,
      lyric: 'one & <two>',
      dynamic: 'mf',
      articulation: 'tenuto',
    });
  });

  it('writes valid independent voice durations using backup, even for unequal overlap', () => {
    const source = createBlankProject();
    source.measures = 2;
    source.parts[0].notes = [
      note('a', 48, 0, 6),
      note('b', 72, 0.5, 2),
      note('c', 74, 3, 2),
      note('d', 76, 6, 1),
    ];
    const xml = toMusicXml(source);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    expect(parsed['score-partwise'].part.measure[0].backup.duration).toBe(3840);
    expect(actualNotes(fromMusicXml(xml))).toEqual(actualNotes(source));
  });

  it('imports source ordered backup/forward, changes and transpose honestly', () => {
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Clarinet</work-title></work><part-list><score-part id="P1"><part-name>Bb Clarinet</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><key><fifths>2</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes><direction><sound tempo="88"/></direction><note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice></note><backup><duration>8</duration></backup><forward><duration>4</duration></forward><note><pitch><step>E</step><octave>4</octave></pitch><duration>12</duration><voice>2</voice></note></measure><measure number="2"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="112"/></direction><note><rest/><duration>12</duration></note><barline><repeat direction="backward"/></barline></measure></part></score-partwise>`;
    const project = fromMusicXml(xml);
    expect(actualNotes(project)[0]).toEqual([
      [70, 0, 2],
      [62, 1, 3],
    ]);
    expect(project.key).toBe('C');
    expect(project.tempo).toBe(88);
    expect(project.source.warnings.join('')).toContain('移调乐器');
    expect(project.source.warnings.join('')).toContain('变拍号');
    expect(project.source.warnings.join('')).toContain('速度变化');
    expect(project.source.warnings.join('')).toContain('反复');
  });

  it('rejects malformed and unsafe XML instead of returning an empty demo', () => {
    expect(() => fromMusicXml('<score-partwise>')).toThrow('语法');
    expect(() => fromMusicXml('<foo/>')).toThrow('score-partwise');
    expect(() =>
      fromMusicXml('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><foo>&x;</foo>'),
    ).toThrow('实体');
  });

  it('writes mathematically consistent glyph durations for arbitrary rational times', () => {
    const source = createBlankProject();
    source.measures = 2;
    source.parts[0].notes = [
      note('triplet', 60, 0, 1 / 3),
      note('awkward', 64, 1 / 3, 0.7),
      note('long', 67, 1.25, 5.125),
    ];
    const ordered = new XMLParser({ ignoreAttributes: false }).parse(toMusicXml(source));
    const measures = ordered['score-partwise'].part.measure;
    const lengths: Record<string, number> = {
      breve: 8,
      whole: 4,
      half: 2,
      quarter: 1,
      eighth: 0.5,
      '16th': 0.25,
      '32nd': 0.125,
      '64th': 0.0625,
    };
    measures.forEach((measure: { note: Record<string, unknown>[] }) =>
      measure.note.forEach((element) => {
        const dots = element.dot === undefined ? 0 : Array.isArray(element.dot) ? element.dot.length : 1;
        const modification = element['time-modification'] as
          { 'normal-notes': number; 'actual-notes': number } | undefined;
        const notated =
          lengths[String(element.type)] *
          (2 - 1 / 2 ** dots) *
          (modification ? modification['normal-notes'] / modification['actual-notes'] : 1);
        expect(notated, JSON.stringify(element)).toBeCloseTo(Number(element.duration) / 960, 8);
      }),
    );
  });
});

describe('MIDI interchange', () => {
  it('writes real SMF with exact header, separate drum channel and UTF-8 names', () => {
    const source = createDemoProject();
    const bytes = toMidi(source);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('MThd');
    const raw = parseMidi(bytes);
    const keys = raw.tracks.flat().filter((event) => event.type === 'keySignature');
    expect(keys).toEqual([expect.objectContaining({ key: -1, scale: 0 })]);
    const drumEvents = raw.tracks.at(-1)!.filter((event) => event.type === 'noteOn');
    expect(drumEvents.every((event) => 'channel' in event && event.channel === 9)).toBe(true);
    const restored = fromMidi(midiBuffer(bytes));
    expect(restored.title).toBe(source.title);
    expect(restored.parts.map((part) => part.name)).toEqual(source.parts.map((part) => part.name));
    expect(restored.tempo).toBeCloseTo(source.tempo, 3);
    expect(restored.key).toBe('F');
    const performed = structuredClone(source);
    for (const part of performed.parts) for (const note of part.notes)
      if (note.articulation === 'staccato') note.duration *= .45;
    expect(actualNotes(restored)).toEqual(actualNotes(performed));
  });

  it.each(['C', 'G', 'Bb', 'Am', 'F#m', 'Cm'])('roundtrips key %s using fifths, not tonic indices', (key) => {
    const source = createBlankProject();
    source.key = key;
    source.parts[0].notes = [note('n', 60, 0, 1)];
    const restored = fromMidi(midiBuffer(toMidi(source)));
    expect(restored.key).toBe(key);
  });

  it('exports selected parts, but mute/solo does not destroy score notes', () => {
    const source = createDemoProject();
    source.parts[0].muted = true;
    expect(fromMidi(midiBuffer(toMidi(source, ['flute']))).parts).toHaveLength(1);
    expect(fromMidi(midiBuffer(toMidi(source, ['flute']))).parts[0].notes.length).toBeGreaterThan(30);
  });

  it('rejects invalid files', () => {
    expect(() => fromMidi(new Uint8Array([0, 1, 2, 3]).buffer)).toThrow('MIDI');
    expect(() => toMidi(createDemoProject(), [])).toThrow('至少');
  });

  it('restores a dominant notation-software MIDI gate without changing free-length MIDI', () => {
    const source = createBlankProject();
    source.parts[0].notes = [
      note('a', 60, 0, 1), note('b', 62, 1, 0.5), note('c', 64, 1.5, 0.5),
      note('d', 65, 2, 2), note('e', 67, 4, 0.25), note('f', 69, 4.25, 0.25),
      note('g', 71, 4.5, 1.5), note('h', 72, 6, 2),
    ];
    const gated = structuredClone(source);
    for (const item of gated.parts[0].notes) item.duration *= 0.95;
    const restored = fromMidi(midiBuffer(toMidi(gated)));
    expect(restored.parts[0].notes.map((item) => item.duration)).toEqual(source.parts[0].notes.map((item) => item.duration));
    expect(restored.source.analysis?.transforms).toContain('midi-notation-gate-restore');
    const raw = fromMidi(midiBuffer(toMidi(gated)), { restoreNotation: false });
    expect(raw.parts[0].notes[0].duration).toBeCloseTo(0.95, 3);

    const free = structuredClone(source);
    free.parts[0].notes.forEach((item, index) => (item.duration *= [0.72, 0.91, 0.83, 0.67, 0.98, 0.76, 0.88, 0.7][index]));
    expect(fromMidi(midiBuffer(toMidi(free))).source.analysis?.transforms ?? []).not.toContain('midi-notation-gate-restore');
  });

  it('prevents GM percussion channel collisions rather than silently cutting notes off', () => {
    const project = createDemoProject();
    project.parts.push({ ...structuredClone(project.parts[4]), id: 'drums2', name: 'Second drums' });
    expect(() => toMidi(project)).toThrow('多个独立鼓轨');
    expect(toMidi(project, ['drums']).byteLength).toBeGreaterThan(100);
  });
});
