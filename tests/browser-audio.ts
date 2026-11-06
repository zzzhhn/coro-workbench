import { PlaybackEngine, renderProjectAudio } from '../src/lib/audio';
import type { PlaybackOptions } from '../src/lib/audio';
import { createBlankProject } from '../src/lib/demo';
import { toAbc, toMidi, toMusicXml, fromMusicXml } from '../src/lib/music';
import { importScoreFile } from '../src/lib/import';
import { parseMidi } from 'midi-file';
import { zipSync, strToU8 } from 'fflate';
import { arrangeForVoices } from '../src/lib/arrange';

const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector('#status')!;
const output = document.querySelector('#results')!;
const results: Array<{ name: string; pass: boolean; details: unknown }> = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name: string, pass: boolean, details: unknown) => {
  results.push({ name, pass, details });
  output.textContent = JSON.stringify(results, null, 2);
  if (!pass) throw new Error(`Failed: ${name}`);
};

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  results.length = 0;
  status.textContent = 'Running with real Web Audio...';
  const engine = new PlaybackEngine();
  let state = { playing: false, beat: 0, peak: 0, mode: 'score' };
  engine.subscribe((next) => {
    state = next;
  });
  const options: PlaybackOptions = {
    mode: 'score',
    startBeat: 0,
    loop: false,
    loopStart: 0,
    loopEnd: 4,
    metronome: false,
    countIn: false,
  };
  try {
    const project = createBlankProject();
    project.measures = 2;
    project.tempo = 120;
    project.parts[0].instrument = 'choir_aahs';
    project.parts[0].program = 52;
    project.parts[0].notes = [{ id: 'held', midi: 60, start: 0, duration: 6, velocity: 0.8 }];
    project.parts.push({
      ...structuredClone(project.parts[0]),
      id: 'second',
      volume: 0.4,
      notes: [{ id: 'n2', midi: 67, start: 0, duration: 6, velocity: 0.7 }],
    });
    await engine.play(project, options);
    await wait(550);
    check('real_sample_playback_nonzero', state.playing && state.peak > 0.003 && state.beat > 0.5, {
      ...state,
    });
    engine.updateMixer(project.parts.map((part) => ({ ...part, muted: true })));
    await wait(300);
    check('mute_all_changes_actual_audio', state.peak < 0.0001, { ...state });
    engine.updateMixer(project.parts.map((part, index) => ({ ...part, muted: false, solo: index === 0 })));
    await wait(250);
    check('solo_restores_actual_audio', state.peak > 0.003, { ...state });
    engine.pause();
    const stoppedBeat = state.beat;
    await wait(150);
    check('pause_stops_audio_and_clock', !state.playing && state.beat === stoppedBeat && state.peak === 0, {
      ...state,
    });
    await engine.play(project, { ...options, startBeat: 3 });
    await wait(220);
    check('mid_note_seek_resumes_sustain', state.beat >= 3 && state.peak > 0.002, { ...state });
    engine.pause();
    await engine.play(project, { ...options, startBeat: 2, loop: true, loopStart: 2, loopEnd: 4 });
    await wait(1450);
    check('loop_wraps_inside_selected_beats', state.beat >= 2 && state.beat < 4 && state.playing, {
      ...state,
    });
    engine.pause();
    await engine.play(project, { ...options, countIn: true });
    await wait(600);
    check('count_in_keeps_score_at_start', state.beat === 0 && state.playing, { ...state });
    engine.pause();
    const rendered = await renderProjectAudio(project, [project.parts[0].id]);
    const left = rendered.buffer.getChannelData(0);
    let peak = 0;
    for (const sample of left) peak = Math.max(peak, Math.abs(sample));
    check('offline_wav_contains_actual_audio', peak > 0.003 && rendered.bytes.length > 10000, {
      duration: rendered.buffer.duration,
      peak,
      bytes: rendered.bytes.length,
    });
    const sourceBlob = new Blob([Uint8Array.from(rendered.bytes)], { type: 'audio/wav' });
    const sourceUrl = URL.createObjectURL(sourceBlob);
    const cropped = {
      ...project,
      measures: 1,
      parts: project.parts.map((part) => ({
        ...part,
        notes: part.notes.map((note) => ({ ...note, duration: 2 })),
      })),
      originalAudio: {
        name: 'original.wav',
        url: sourceUrl,
        duration: rendered.buffer.duration,
        offsetSeconds: 0,
        tempo: 120,
      },
    };
    await engine.play(cropped, { ...options, mode: 'source', startBeat: 4.5 });
    await wait(250);
    check('full_original_plays_beyond_analyzed_score', state.playing && state.beat > 4.5, {
      ...state,
      scoreEnd: 4,
    });
    engine.pause();
    URL.revokeObjectURL(sourceUrl);
    const silent = structuredClone(project);
    silent.parts.forEach((part) => part.notes.forEach((note) => (note.velocity = 0)));
    const silentRender = await renderProjectAudio(silent);
    let silentPeak = 0;
    for (const sample of silentRender.buffer.getChannelData(0))
      silentPeak = Math.max(silentPeak, Math.abs(sample));
    check('zero_velocity_is_silent', silentPeak === 0, { silentPeak });
    const dynamicSource = createBlankProject();
    dynamicSource.tempo = 120;
    dynamicSource.measures = 2;
    dynamicSource.parts[0].notes = Array.from({ length: 4 }, (_, index) => ({
      id: `dynamic-${index}`, midi: 60, start: index * 2, duration: 1, velocity: .75,
      ...(index === 0 ? { dynamic: 'p' as const } : index === 3 ? { dynamic: 'f' as const } : {}),
    }));
    const dynamicImported = fromMusicXml(toMusicXml(dynamicSource));
    const dynamicAudio = await renderProjectAudio(dynamicImported);
    const explicitDynamics = structuredClone(dynamicImported);
    let dynamicIndex = 0;
    for (const note of explicitDynamics.parts[0].notes)
      if (note.midi !== null) note.dynamic = dynamicIndex++ === 3 ? 'f' : 'p';
    const explicitAudio = await renderProjectAudio(explicitDynamics);
    const dynamicLevels = (buffer: AudioBuffer) => Array.from({ length: 4 }, (_, index) => {
      const samples = buffer.getChannelData(0).slice(Math.floor((index + .06) * 44100), Math.floor((index + .26) * 44100));
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    });
    const levels = dynamicLevels(dynamicAudio.buffer), referenceLevels = dynamicLevels(explicitAudio.buffer);
    check('imported_dynamic_persists_in_actual_render', levels[0] > .0001 && levels.every((level, index) => Math.abs(level / referenceLevels[index] - 1) < .02) && levels[3] > levels[1] * 1.3, {
      levels, referenceLevels, printedMarks: dynamicImported.parts[0].notes.filter((n) => n.dynamic).length,
    });
    const heldSource = createBlankProject();
    heldSource.tempo = 65;
    heldSource.measures = 12;
    heldSource.parts[0].notes = [{ id: 'breath-held', midi: 72, start: 0, duration: 48, velocity: 0.8 }];
    heldSource.chords = [{ start: 0, duration: 48, symbol: 'C', pitches: [48, 52, 55] }];
    const breathed = arrangeForVoices(heldSource, {
      preset: 'satb',
      style: 'choral',
      difficulty: 'medium',
      percussion: false,
      transpose: 0,
    });
    const planned = breathed.arrangement!.report.breathing![0].plannedGaps!;
    const cut = planned[0];
    const breathAudio = await renderProjectAudio(breathed, [breathed.parts[0].id]);
    const breathSamples = breathAudio.buffer.getChannelData(0);
    const samplePeak = (from: number, to: number) => {
      let value = 0;
      for (
        let frame = Math.floor(from * breathAudio.buffer.sampleRate);
        frame < to * breathAudio.buffer.sampleRate;
        frame++
      )
        value = Math.max(value, Math.abs(breathSamples[frame] ?? 0));
      return value;
    };
    const gapStart = (cut.startBeat * 60) / breathed.tempo;
    const gapEnd = (cut.resumeBeat * 60) / breathed.tempo;
    const breathPeaks = {
      before: samplePeak(gapStart - 1, gapStart - 0.8),
      middle: samplePeak(gapStart + 0.15, gapEnd - 0.04),
      after: samplePeak(gapEnd + 0.2, gapEnd + 0.4),
    };
    check(
      'planned_vocal_breath_is_real_silence_and_resumes',
      planned.length > 0 &&
        gapEnd - gapStart >= 0.3 &&
        breathPeaks.before > 0.001 &&
        breathPeaks.middle < 0.0001 &&
        breathPeaks.after > 0.001,
      {
        plannedGaps: planned.length,
        gapSeconds: [gapStart, gapEnd],
        peaks: breathPeaks,
        sourceHeldDurationUnchanged: heldSource.parts[0].notes[0].duration === 48,
      },
    );
    const xml = toMusicXml(project);
    const imported = fromMusicXml(xml);
    check(
      'browser_musicxml_roundtrip',
      imported.parts.length === 2 &&
        imported.parts[0].notes[0].midi === 60 &&
        imported.parts[0].notes[0].duration === 6,
      { parts: imported.parts.length, notes: imported.parts[0].notes.length },
    );
    const zipped = zipSync({
      'META-INF/container.xml': strToU8(
        '<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>',
      ),
      'score.musicxml': strToU8(xml),
    });
    const compressed = await importScoreFile(new File([Uint8Array.from(zipped)], 'test.mxl'));
    check('compressed_musicxml_import', compressed.parts.length === 2, { parts: compressed.parts.length });
    const midi = parseMidi(toMidi(project));
    const keys = midi.tracks.flat().filter((event) => event.type === 'keySignature');
    check(
      'midi_key_signature_not_corrupted',
      keys.length === 1 && 'key' in keys[0] && keys[0].key === 0,
      keys,
    );
    const abc = toAbc(project);
    check(
      'notation_has_edit_mapping',
      Object.values(abc.noteMap).some((note) => note.noteId === 'held'),
      { mappedCharacters: Object.keys(abc.noteMap).length },
    );
    status.textContent = `PASS ${results.length}/${results.length}. Mechanical browser checks, not human listening acceptance.`;
    const report = {
      generatedAt: new Date().toISOString(),
      scope: 'Real Web Audio and interchange checks in user-gesture browser, original isolated fixture',
      results,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.id = 'download-report';
    link.href = url;
    link.download = 'coro-browser-audio-validation.json';
    link.textContent = 'Download validation evidence';
    document.body.appendChild(link);
  } catch (error) {
    status.textContent = `FAIL: ${error instanceof Error ? error.message : error}`;
  } finally {
    engine.dispose();
    runButton.disabled = false;
  }
});
