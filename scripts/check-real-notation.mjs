import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import abcjs from 'abcjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const manifestPath = path.resolve(ROOT, option('--manifest', 'evidence/phase2/four-full-songs.json'));
const outputPath = path.resolve(ROOT, option('--output', 'evidence/phase2/real-notation-qa.json'));
const alternativesPath = option('--alternatives', undefined);
const watch = args.includes('--watch');
const intervalSeconds = Number(option('--interval', '45'));
const watchTimeoutSeconds = Number(option('--watch-timeout', '3600'));
if (!(intervalSeconds >= 5) || !(watchTimeoutSeconds > 0)) throw new Error('Invalid watch interval/timeout.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const rounded = (value, digits = 6) => Number(Number(value).toFixed(digits));
const wholeBeats = (project) => (project.measures * project.timeSignature[0] * 4) / project.timeSignature[1];
const pitched = (part) => part.notes.filter((note) => note.midi !== null);
const partLookup = (project) => new Map(project.parts.map((part) => [part.id, part]));
const tuple = (note) => [note.midi, rounded(note.start), rounded(note.duration)];
const tupleKey = (event) => JSON.stringify(event);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function multiset(events) {
  const values = new Map();
  for (const event of events) {
    const key = tupleKey(event);
    values.set(key, (values.get(key) ?? 0) + 1);
  }
  return values;
}

function difference(expectedEvents, actualEvents) {
  const expected = multiset(expectedEvents);
  const actual = multiset(actualEvents);
  let missingCount = 0;
  let extraCount = 0;
  const missingExamples = [];
  const extraExamples = [];
  for (const [key, count] of expected) {
    const missing = Math.max(0, count - (actual.get(key) ?? 0));
    missingCount += missing;
    if (missing && missingExamples.length < 5)
      missingExamples.push({ tuple: JSON.parse(key), count: missing });
  }
  for (const [key, count] of actual) {
    const extra = Math.max(0, count - (expected.get(key) ?? 0));
    extraCount += extra;
    if (extra && extraExamples.length < 5) extraExamples.push({ tuple: JSON.parse(key), count: extra });
  }
  return {
    sourceEvents: expectedEvents.length,
    decodedEvents: actualEvents.length,
    exactPitchOnsetDuration: missingCount === 0 && extraCount === 0,
    missingCount,
    extraCount,
    missingExamples,
    extraExamples,
  };
}

const checkerSelfTests = (() => {
  const original = [
    [60, 0, 1],
    [60, 0, 1],
    [64, 1, 0.125],
  ];
  const results = {
    acceptsPermutation: difference(original, [...original].reverse()).exactPitchOnsetDuration,
    detectsLostDuplicate: !difference(original, original.slice(1)).exactPitchOnsetDuration,
    detectsPitchMutation: !difference(original, [[61, 0, 1], ...original.slice(1)]).exactPitchOnsetDuration,
    detectsOnsetMutation: !difference(original, [[60, 0.125, 1], ...original.slice(1)])
      .exactPitchOnsetDuration,
    detectsDurationMutation: !difference(original, [[60, 0, 0.5], ...original.slice(1)])
      .exactPitchOnsetDuration,
  };
  if (!Object.values(results).every(Boolean))
    throw new Error('Independent multiset checker self-test failed.');
  return results;
})();

function distribution(values) {
  if (!values.length) return { count: 0, mean: 0, median: 0, p95: 0, maximum: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: rounded(values.reduce((a, b) => a + b, 0) / values.length, 9),
    median: rounded(sorted[Math.floor((sorted.length - 1) * 0.5)], 9),
    p95: rounded(sorted[Math.floor((sorted.length - 1) * 0.95)], 9),
    maximum: rounded(sorted.at(-1), 9),
  };
}

function sourceNoteStatistics(part) {
  const notes = pitched(part);
  const events = notes
    .flatMap((note) => [
      [note.start, 1],
      [note.start + note.duration, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let maximumPolyphony = 0;
  let overlapBeats = 0;
  let previousTime = 0;
  for (const [time, delta] of events) {
    if (active > 1) overlapBeats += Math.max(0, time - previousTime);
    active += delta;
    maximumPolyphony = Math.max(maximumPolyphony, active);
    previousTime = time;
  }
  const onsets = new Map();
  for (const note of notes) onsets.set(rounded(note.start), (onsets.get(rounded(note.start)) ?? 0) + 1);
  return {
    pitchedEvents: notes.length,
    explicitRests: part.notes.length - notes.length,
    pitchRange: notes.length
      ? [Math.min(...notes.map((note) => note.midi)), Math.max(...notes.map((note) => note.midi))]
      : null,
    maximumPolyphony,
    overlapBeats: rounded(overlapBeats),
    simultaneousOnsetGroups: [...onsets.values()].filter((count) => count > 1).length,
    additionalSimultaneousOnsets: [...onsets.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ),
    subSixteenthNotes: notes.filter((note) => note.duration < 0.25 - 1e-8).length,
  };
}

function emptyComplexity(part) {
  return {
    partId: part.id,
    partName: part.name,
    source: sourceNoteStatistics(part),
    writtenNoteGroups: 0,
    writtenPitchHeads: 0,
    visibleRestGlyphs: 0,
    hiddenSpacers: 0,
    subSixteenthNoteGroups: 0,
    subSixteenthPitchHeads: 0,
    subSixteenthRestGlyphs: 0,
    subThirtySecondRestGlyphs: 0,
    continuationPitchHeads: 0,
    tieStarts: 0,
    unmappedPitchHeads: 0,
    systemsWithContent: 0,
  };
}

function notationComplexity(tune, result, project, partIds) {
  const selected = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  const values = new Map(selected.map((part) => [part.id, emptyComplexity(part)]));
  const activeSystems = new Map(selected.map((part) => [part.id, new Set()]));
  let system = 0;
  for (const line of tune.lines) {
    if (!line.staff) continue;
    line.staff.forEach((staff, staffIndex) => {
      const partId = result.staffMap?.[staffIndex]?.partId;
      const value = values.get(partId);
      if (!value) return;
      for (const voice of staff.voices ?? []) {
        let multiplier = 1;
        for (const event of voice ?? []) {
          if (event.el_type !== 'note') continue;
          if (event.startTriplet) multiplier = event.tripletMultiplier ?? 1;
          const segment = result.noteSegments?.[event.startChar];
          const duration = segment?.duration ?? (event.duration ?? 0) * 4 * multiplier;
          const small = duration > 0 && duration < 0.25 - 1e-8;
          if (event.pitches?.length) {
            value.writtenNoteGroups++;
            value.writtenPitchHeads += event.pitches.length;
            value.continuationPitchHeads += event.pitches.filter((pitch) => pitch.endTie).length;
            value.tieStarts += event.pitches.filter((pitch) => pitch.startTie).length;
            value.unmappedPitchHeads += event.pitches.filter((_, index) => !segment?.noteIds[index]).length;
            if (small) {
              value.subSixteenthNoteGroups++;
              value.subSixteenthPitchHeads += event.pitches.length;
            }
            activeSystems.get(partId).add(system);
          } else if (event.rest && event.rest.type !== 'spacer') {
            value.visibleRestGlyphs++;
            if (small) value.subSixteenthRestGlyphs++;
            if (duration > 0 && duration < 0.125 - 1e-8) value.subThirtySecondRestGlyphs++;
          } else if (event.rest) value.hiddenSpacers++;
          if (event.endTriplet) multiplier = 1;
        }
      }
    });
    system++;
  }
  return [...values.values()].map((value) => ({
    ...value,
    systemsWithContent: activeSystems.get(value.partId).size,
  }));
}

const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'coro-notation-qa-'));
const server = await createServer({
  root: ROOT,
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  cacheDir: cacheDirectory,
  logLevel: 'error',
});
const moduleFiles = [
  'src/lib/music.ts',
  'src/lib/engraving.ts',
  'src/lib/arrange.ts',
  'src/lib/scoreTools.ts',
  'src/lib/readability.ts',
  'src/lib/types.ts',
];
const moduleHashes = Object.fromEntries(
  await Promise.all(moduleFiles.map(async (file) => [file, sha256(await readFile(path.join(ROOT, file)))])),
);
const moduleFingerprint = sha256(JSON.stringify(moduleHashes));
const checkerSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
const music = await server.ssrLoadModule('/src/lib/music.ts');
const engraving = await server.ssrLoadModule('/src/lib/engraving.ts');
const arranger = await server.ssrLoadModule('/src/lib/arrange.ts');
const scoreTools = await server.ssrLoadModule('/src/lib/scoreTools.ts');
const readability = await server.ssrLoadModule('/src/lib/readability.ts');

function auditEngravedPitchSpelling(tune, result, project) {
  const sources = new Map(
    project.parts.flatMap((part) => part.notes.map((note) => [`${part.id}\0${note.id}`, note])),
  );
  const degrees = [0, 2, 4, 5, 7, 9, 11];
  const letterDegrees = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };
  const alters = { natural: 0, sharp: 1, flat: -1, dblsharp: 2, dblflat: -2 };
  let checkedHeads = 0;
  let mismatchedHeads = 0;
  const examples = [];
  const heldAccidentals = new Map();
  for (const line of tune.lines)
    (line.staff ?? []).forEach((staff, staffIndex) => {
      const map = result.staffMap[staffIndex];
      for (const voice of staff.voices ?? []) {
        let key = Object.fromEntries(
          (staff.key?.accidentals ?? []).map((accidental) => [
            letterDegrees[accidental.note.toLowerCase()],
            alters[accidental.acc] ?? 0,
          ]),
        );
        const barAccidentals = new Map();
        for (const event of voice ?? []) {
          if (event.el_type === 'bar') barAccidentals.clear();
          if (event.el_type === 'keySignature') {
            key = Object.fromEntries(
              (event.accidentals ?? []).map((accidental) => [
                letterDegrees[accidental.note.toLowerCase()],
                alters[accidental.acc] ?? 0,
              ]),
            );
            barAccidentals.clear();
          }
          if (!event.pitches?.length) continue;
          const segment = result.noteSegments[event.startChar];
          event.pitches.forEach((pitch, index) => {
            const noteKey = `${map.partId}\0${segment?.noteIds[index]}`;
            const source = sources.get(noteKey);
            // Raw abcjs partial-chord endTie flags are positional, not pitch
            // identities. Track continuations by event ID, never by source MIDI.
            const continuation = source && segment.start > source.start + 1e-7;
            let writtenMidi;
            if (map.clef === 'percussion') writtenMidi = tune.formatting.percmap?.[pitch.name]?.sound;
            else {
              // A tied continuation may repeat its accidental after a barline,
              // but it does not establish that accidental for later attacks.
              const explicit = alters[pitch.accidental];
              if (explicit !== undefined && !continuation) barAccidentals.set(pitch.pitch, explicit);
              const degree = ((pitch.pitch % 7) + 7) % 7;
              const accidental = explicit ?? (continuation ? heldAccidentals.get(noteKey) : undefined) ?? barAccidentals.get(pitch.pitch) ?? key[degree] ?? 0;
              heldAccidentals.set(noteKey, accidental);
              writtenMidi =
                60 +
                Math.floor(pitch.pitch / 7) * 12 +
                degrees[degree] +
                accidental;
            }
            const expected = source?.midi;
            checkedHeads++;
            if (writtenMidi !== expected) {
              mismatchedHeads++;
              if (examples.length < 6)
                examples.push({
                  partId: map.partId,
                  sourceNoteId: segment?.noteIds[index],
                  writtenName: pitch.name,
                  diatonicPitch: pitch.pitch,
                  writtenMidi,
                  expectedMidi: expected,
                  onset: segment?.start,
                });
            }
          });
        }
      }
    });
  return {
    passed: mismatchedHeads === 0,
    checkedHeads,
    mismatchedHeads,
    examples,
    method:
      'Independent written pitch + key + measure accidental decoding before afterParsing; event IDs track tie continuation, not expected MIDI. No injected midipitch values; percussion uses emitted GM percmap.',
  };
}

function auditAbc(project, partIds) {
  const started = performance.now();
  const result = music.toAbc(project, partIds);
  const tunes = abcjs.parseOnly(result.abc);
  if (tunes.length !== 1) throw new Error(`Expected one ABC tune, got ${tunes.length}.`);
  const engravedPitchSpelling = auditEngravedPitchSpelling(tunes[0], result, project);
  const tune = engraving.prepareEngravingTune(tunes[0], result);
  const complexity = notationComplexity(tune, result, project, partIds);
  const audio = tune.setUpAudio({ chordsOff: true });
  const trackPartIds = result.staffMap.flatMap((staff) => staff.voiceIds.map(() => staff.partId));
  const decoded = new Map();
  const unmappedTracks = [];
  audio.tracks.forEach((track, index) => {
    if (!trackPartIds[index]) {
      unmappedTracks.push(index);
      return;
    }
    const values = decoded.get(trackPartIds[index]) ?? [];
    values.push(
      ...track
        .filter((event) => event.cmd === 'note')
        .map((event) => [event.pitch, rounded(event.start * 4), rounded(event.duration * 4)]),
    );
    decoded.set(trackPartIds[index], values);
  });
  const selected = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  const checks = selected.map((part) => ({
    partId: part.id,
    ...difference(pitched(part).map(tuple), decoded.get(part.id) ?? []),
  }));
  return {
    passed:
      engravedPitchSpelling.passed &&
      checks.every((check) => check.exactPitchOnsetDuration) &&
      !unmappedTracks.length &&
      !tune.warnings?.length &&
      Math.abs(audio.totalDuration * 4 - wholeBeats(project)) < 1e-5,
    elapsedMs: rounded(performance.now() - started, 1),
    expectedBeats: wholeBeats(project),
    decodedBeats: rounded(audio.totalDuration * 4),
    parseWarningCount: tune.warnings?.length ?? 0,
    parseWarningExamples: (tune.warnings ?? []).slice(0, 5),
    unmappedTracks,
    staffMap: result.staffMap,
    systemCount: result.systemMeasures.length,
    maximumVoicesPerStaff: Math.max(...result.staffMap.map((staff) => staff.voiceIds.length)),
    projectionWarningCount: result.warnings?.length ?? 0,
    projectionWarnings: result.warnings ?? [],
    engravedPitchSpelling,
    eventChecks: checks,
    complexity,
  };
}

function auditXml(project) {
  const started = performance.now();
  const xml = music.toMusicXml(project);
  const restored = music.fromMusicXml(xml);
  const checks = project.parts.map((part, index) => ({
    partId: part.id,
    importedName: restored.parts[index]?.name,
    ...difference(
      pitched(part).map(tuple),
      restored.parts[index] ? pitched(restored.parts[index]).map(tuple) : [],
    ),
  }));
  return {
    passed:
      restored.parts.length === project.parts.length &&
      checks.every((check) => check.exactPitchOnsetDuration),
    reader:
      'Current Coro MusicXML importer; independent ABC event audit is separate. Not an external notation-application acceptance test.',
    scope:
      'All pitched and percussion events. Newly generated display rests/voice padding are not counted as original source notes.',
    elapsedMs: rounded(performance.now() - started, 1),
    xmlSha256: sha256(xml),
    sourceParts: project.parts.length,
    importedParts: restored.parts.length,
    sourceMeasures: project.measures,
    importedMeasures: restored.measures,
    importWarnings: restored.source.warnings,
    eventChecks: checks,
  };
}

function auditProject(project, label) {
  const originalFingerprint = sha256(JSON.stringify(project));
  const validationErrors = music.validateProject(project);
  const report = {
    label,
    validationErrors,
    tempo: project.tempo,
    measures: project.measures,
    notes: project.parts.reduce((sum, part) => sum + pitched(part).length, 0),
  };
  if (validationErrors.length) return { ...report, passed: false };
  const lead = arranger.recommendLeadPart(project);
  report.recommendedLead = lead ? { partId: lead.id, name: lead.name, notes: pitched(lead).length } : null;
  for (const [key, run] of [
    ['fullAbc', () => auditAbc(project)],
    ['soloLeadAbc', () => (lead ? auditAbc(project, [lead.id]) : null)],
    ['musicxmlRoundtrip', () => auditXml(project)],
  ]) {
    try {
      report[key] = run();
    } catch (error) {
      report[key] = { passed: false, error: String(error.message ?? error) };
    }
  }
  report.projectUnchanged = originalFingerprint === sha256(JSON.stringify(project));
  report.passed =
    report.projectUnchanged &&
    report.fullAbc.passed &&
    report.musicxmlRoundtrip.passed &&
    (!lead || report.soloLeadAbc.passed);
  return report;
}

function physicalComparison(source, modified) {
  const original = new Map(
    source.parts.flatMap((part) => part.notes.map((note) => [`${part.id}\0${note.id}`, note])),
  );
  const proposed = new Map(
    modified.parts.flatMap((part) => part.notes.map((note) => [`${part.id}\0${note.id}`, note])),
  );
  const starts = [];
  const durations = [];
  const audioOffsets = [];
  let pitchChanges = 0;
  let changedTimedNotes = 0;
  for (const [key, note] of original) {
    const next = proposed.get(key);
    if (!next) continue;
    if (note.midi !== next.midi) pitchChanges++;
    const onset = Math.abs((next.start * 60) / modified.tempo - (note.start * 60) / source.tempo);
    const duration = Math.abs((next.duration * 60) / modified.tempo - (note.duration * 60) / source.tempo);
    if (onset > 1e-8 || duration > 1e-8) changedTimedNotes++;
    starts.push(onset);
    durations.push(duration);
    if (source.originalAudio && modified.originalAudio)
      audioOffsets.push(
        Math.abs(
          (next.start * 60) / (modified.originalAudio.tempo ?? modified.tempo) +
            modified.originalAudio.offsetSeconds -
            (note.start * 60) / (source.originalAudio.tempo ?? source.tempo) -
            source.originalAudio.offsetSeconds,
        ),
      );
  }
  const missingNoteIds = [...original.keys()].filter((key) => !proposed.has(key));
  const addedNoteIds = [...proposed.keys()].filter((key) => !original.has(key));
  return {
    sameCanonicalNoteCountAndIds: !missingNoteIds.length && !addedNoteIds.length,
    missingNoteCount: missingNoteIds.length,
    addedNoteCount: addedNoteIds.length,
    pitchChanges,
    changedTimedNotes,
    preservesEveryPhysicalOnsetAndDuration:
      !missingNoteIds.length && !addedNoteIds.length && changedTimedNotes === 0,
    onsetShiftSeconds: distribution(starts),
    durationShiftSeconds: distribution(durations),
    originalAudioOnsetShiftSeconds: distribution(audioOffsets),
  };
}

function leadArrangementChanges(source, arranged) {
  const sourcePart = source.parts.find((part) => part.id === arranged.arrangement?.options.leadPartId);
  const targetPart = arranged.parts.find((part) => part.role === 'lead');
  if (!sourcePart || !targetPart) return { error: 'Missing lead part identity.' };
  const original = pitched(sourcePart);
  const target = pitched(targetPart);
  const onsetDifference = difference(
    original.map((note) => [rounded(note.start)]),
    target.map((note) => [rounded(note.start)]),
  );
  const sourceOnsets = new Map();
  original.forEach((note) => {
    const key = rounded(note.start);
    const list = sourceOnsets.get(key) ?? [];
    list.push(note);
    sourceOnsets.set(key, list);
  });
  const pitchDeltas = new Map();
  let nonOctavePitchChanges = 0;
  let modifiedDurations = 0;
  let sameOnsetComparisons = 0;
  for (const note of target) {
    const previous = sourceOnsets.get(rounded(note.start))?.shift();
    if (!previous) continue;
    sameOnsetComparisons++;
    const delta = note.midi - previous.midi;
    pitchDeltas.set(delta, (pitchDeltas.get(delta) ?? 0) + 1);
    if (delta % 12 !== 0) nonOctavePitchChanges++;
    if (Math.abs(note.duration - previous.duration) > 1e-6) modifiedDurations++;
  }
  return {
    sourcePartId: sourcePart.id,
    sourceNotes: original.length,
    generatedLeadNotes: target.length,
    sameOnsetComparisons,
    missingSourceOnsets: onsetDifference.missingCount,
    addedOnsets: onsetDifference.extraCount,
    pitchDeltaHistogram: Object.fromEntries([...pitchDeltas].sort((a, b) => a[0] - b[0])),
    nonOctavePitchChanges,
    durationChangesAtMatchedOnsets: modifiedDurations,
    sourceMonophonic: sourceNoteStatistics(sourcePart).maximumPolyphony <= 1,
    reportChanges: arranged.arrangement.report.changes,
    reportWarnings: arranged.arrangement.report.warnings,
    scope:
      'Observed source-to-vocal edits, not transcription correctness. Octave changes and breathing are expected disclosed arrangement changes.',
  };
}

function candidateAssessment(project, lead, candidate) {
  const body = candidate.project;
  const physical = physicalComparison(project, body);
  const leadPhysical = physicalComparison(
    { ...project, parts: project.parts.filter((part) => part.id === lead.id) },
    { ...body, parts: body.parts.filter((part) => part.id === lead.id) },
  );
  const abc = auditAbc(body, [lead.id]);
  const complexity = abc.complexity[0];
  const changedLead = body.parts.find((part) => part.id === lead.id);
  return {
    id: candidate.id,
    beatFactor: candidate.factor,
    leadQuantizeStepBeats: candidate.quantize ? 0.25 : null,
    tempo: body.tempo,
    measures: body.measures,
    sourceScoreLengthSeconds: rounded((wholeBeats(project) * 60) / project.tempo),
    projectedScoreLengthSeconds: rounded((wholeBeats(body) * 60) / body.tempo),
    operationChangedNotes: candidate.changedNotes,
    warnings: candidate.warnings,
    physical,
    leadPhysical,
    leadSourceNoteStatistics: sourceNoteStatistics(changedLead),
    soloLeadAbcPassed: abc.passed,
    parseWarningCount: abc.parseWarningCount,
    eventChecks: abc.eventChecks,
    systemCount: abc.systemCount,
    complexity,
  };
}

function manualCandidates(project) {
  const originalFingerprint = sha256(JSON.stringify(project));
  const lead = arranger.recommendLeadPart(project);
  if (!lead) return { error: 'No pitched lead available.' };
  const results = [];
  for (const factor of [1, 0.5, 2]) {
    for (const quantize of [false, true]) {
      const id = `${factor === 1 ? 'original_units' : factor === 0.5 ? 'half_units' : 'double_units'}${quantize ? '_lead_sixteenth_quantize' : ''}`;
      try {
        const base =
          factor === 1
            ? { project: structuredClone(project), changedNotes: 0, warnings: [] }
            : scoreTools.reinterpretBeatUnit(project, factor);
        const result = quantize
          ? scoreTools.quantizeSelection(
              base.project,
              { partIds: [lead.id], startMeasure: 1, endMeasure: base.project.measures },
              0.25,
            )
          : base;
        results.push(
          candidateAssessment(project, lead, {
            id,
            factor,
            quantize,
            project: result.project,
            changedNotes: result.changedNotes,
            warnings: [...new Set([...base.warnings, ...result.warnings])],
          }),
        );
      } catch (error) {
        results.push({ id, error: String(error.message ?? error) });
      }
    }
  }
  const baseline = results.find((result) => result.id === 'original_units');
  for (const result of results)
    if (!result.error && baseline?.complexity) {
      result.deltaVsBaseline = {
        subSixteenthRestGlyphs:
          result.complexity.subSixteenthRestGlyphs - baseline.complexity.subSixteenthRestGlyphs,
        subSixteenthNoteGroups:
          result.complexity.subSixteenthNoteGroups - baseline.complexity.subSixteenthNoteGroups,
        visibleRestGlyphs: result.complexity.visibleRestGlyphs - baseline.complexity.visibleRestGlyphs,
        writtenNoteGroups: result.complexity.writtenNoteGroups - baseline.complexity.writtenNoteGroups,
        tieStarts: result.complexity.tieStarts - baseline.complexity.tieStarts,
        systems: result.systemCount - baseline.systemCount,
        maximumLeadPolyphony:
          result.leadSourceNoteStatistics.maximumPolyphony -
          baseline.leadSourceNoteStatistics.maximumPolyphony,
      };
    }
  const exactCandidates = results.filter(
    (result) =>
      !result.error &&
      result.soloLeadAbcPassed &&
      result.physical.preservesEveryPhysicalOnsetAndDuration &&
      result.physical.pitchChanges === 0,
  );
  const best = [...exactCandidates].sort(
    (a, b) =>
      a.complexity.subSixteenthRestGlyphs +
        a.complexity.subSixteenthNoteGroups -
        b.complexity.subSixteenthRestGlyphs -
        b.complexity.subSixteenthNoteGroups || a.systemCount - b.systemCount,
  )[0];
  return {
    selectedLead: { partId: lead.id, name: lead.name, sourceNotes: pitched(lead).length },
    sourceUnchanged: originalFingerprint === sha256(JSON.stringify(project)),
    appliedToSource: false,
    definitions: {
      sixteenthGridQuarterNoteBeats: 0.25,
      quantizationScope:
        'Lead only, all measures; other parts and chord events remain unchanged except global beat-unit reinterpretation.',
      exactCandidateRanking:
        'Among exact-physical-seconds + no pitch/ID loss candidates, prefer fewer sub-sixteenth note groups plus visible rest glyphs; break ties by system count. This is not a perceptual readability score.',
    },
    bestExactSecondsCandidate: best?.id ?? null,
    recommendation:
      best && best.id !== 'original_units'
        ? `Offer ${best.id} only as an explicit reversible rehearsal view: it preserves physical note seconds but changes bar/BPM interpretation and may increase systems. Do not overwrite detected beat truth or auto-apply quantization.`
        : 'No verified exact-seconds candidate improves the selected short-glyph objective; retain original view and use explicit manual repairs.',
    candidates: results,
  };
}

async function auditAlternatives(file) {
  const manifestBytes = await readFile(path.resolve(ROOT, file));
  const manifest = JSON.parse(manifestBytes);
  const baselineCache = new Map();
  const results = [];
  for (const entry of manifest.alternatives ?? []) {
    if (entry.profile !== 'legato') continue;
    console.log(`Auditing optional ${entry.profile}: ${entry.song}`);
    try {
      const standard = await readSnapshot(entry.standardProject);
      const alternative = await readSnapshot(entry.project);
      const originalFingerprint = sha256(JSON.stringify(alternative.project));
      const sourceParts = partLookup(standard.project);
      const alternativeParts = partLookup(alternative.project);
      const leadId = 'vocals';
      if (!sourceParts.has(leadId) || !alternativeParts.has(leadId))
        throw new Error('Comparison requires same source vocals part ID.');
      let baseline = baselineCache.get(standard.hash);
      if (!baseline) {
        baseline = auditAbc(standard.project, [leadId]);
        baselineCache.set(standard.hash, baseline);
      }
      const result = auditProject(
        alternative.project,
        `Optional ${entry.profile} DP profile, never applied as default`,
      );
      const abc = auditAbc(alternative.project, [leadId]);
      const double = reinterpretForAudit(alternative.project, leadId);
      const otherPartsExact = standard.project.parts
        .filter((part) => part.id !== leadId)
        .map((part) => ({
          partId: part.id,
          entirePartUnchanged: JSON.stringify(part) === JSON.stringify(alternativeParts.get(part.id)),
        }));
      const metrics = abc.complexity[0];
      const prior = baseline.complexity[0];
      results.push({
        song: entry.song,
        profile: entry.profile,
        sourcePaths: { standard: standard.path, optional: alternative.path },
        sourceSha256: { standard: standard.hash, optional: alternative.hash },
        sourceLeadCount: pitched(sourceParts.get(leadId)).length,
        optionalLeadCount: pitched(alternativeParts.get(leadId)).length,
        leadEventRatio: rounded(
          pitched(alternativeParts.get(leadId)).length / pitched(sourceParts.get(leadId)).length,
          3,
        ),
        baselineLeadComplexity: prior,
        optionalLeadComplexity: metrics,
        complexityChange: {
          noteGroups: metrics.writtenNoteGroups - prior.writtenNoteGroups,
          visibleRests: metrics.visibleRestGlyphs - prior.visibleRestGlyphs,
          subSixteenthNotes: metrics.subSixteenthNoteGroups - prior.subSixteenthNoteGroups,
          subSixteenthRests: metrics.subSixteenthRestGlyphs - prior.subSixteenthRestGlyphs,
          tieStarts: metrics.tieStarts - prior.tieStarts,
        },
        otherPartsExact,
        originalAudioReferenceUnchanged:
          JSON.stringify(standard.project.originalAudio) ===
          JSON.stringify(alternative.project.originalAudio),
        optionalProjectAudit: result,
        optionalLeadDoubleUnits: double,
        sourceObjectUnchanged: originalFingerprint === sha256(JSON.stringify(alternative.project)),
        alternativeFileStable: sha256(await readFile(alternative.path)) === alternative.hash,
        appliedAsDefault: false,
        interpretation:
          'This profile changes the proposed event sequence; glyph complexity and independent pitch-model agreement measure different properties. More events are not automatically better or worse. This report supplies no ground-truth accuracy or default-switch approval.',
      });
    } catch (error) {
      results.push({ song: entry.song, profile: entry.profile, error: String(error.stack ?? error) });
    }
  }
  return {
    manifestPath: path.resolve(ROOT, file),
    manifestSha256: sha256(manifestBytes),
    testedProfiles: ['legato'],
    detailedProfileNotTested: true,
    results,
  };
}

function reinterpretForAudit(project, leadId) {
  const doubled = scoreTools.reinterpretBeatUnit(project, 2);
  const lead = project.parts.find((part) => part.id === leadId);
  return candidateAssessment(project, lead, {
    id: 'double_units',
    factor: 2,
    quantize: false,
    project: doubled.project,
    changedNotes: doubled.changedNotes,
    warnings: doubled.warnings,
  });
}

async function readSnapshot(file) {
  const absolute = path.resolve(ROOT, file);
  const bytes = await readFile(absolute);
  return { path: absolute, hash: sha256(bytes), project: JSON.parse(bytes) };
}

async function auditSong(entry) {
  const raw = await readSnapshot(entry.rawProjectPath);
  const clean = await readSnapshot(entry.projectPath);
  const before = { raw: sha256(JSON.stringify(raw.project)), clean: sha256(JSON.stringify(clean.project)) };
  const stages = {};
  stages.rawOriginal = auditProject(raw.project, 'Raw automatic transcription, not ground truth');
  stages.cleanProposal = auditProject(
    clean.project,
    'Current cleaned multi-model proposal, not accepted truth',
  );
  let arrangement;
  try {
    const generated = arranger.arrangeForVoices(clean.project, {
      preset: 'satb',
      style: 'pop',
      difficulty: 'medium',
      percussion: true,
      transpose: 0,
    });
    stages.satbFromClean = auditProject(generated, 'New local SATB proposal, not applied to saved source');
    arrangement = leadArrangementChanges(clean.project, generated);
  } catch (error) {
    stages.satbFromClean = { passed: false, error: String(error.message ?? error) };
  }
  const candidates = manualCandidates(clean.project);
  const recommendedLead = arranger.recommendLeadPart(clean.project);
  const guardedReadabilitySuggestion = readability.notationReadabilitySummary(
    clean.project,
    recommendedLead ? [recommendedLead.id] : undefined,
  );
  const rawParts = partLookup(raw.project);
  const cleanParts = partLookup(clean.project);
  const stageCountChanges = [...new Set([...rawParts.keys(), ...cleanParts.keys()])].map((id) => ({
    partId: id,
    rawEvents: rawParts.has(id) ? pitched(rawParts.get(id)).length : 0,
    cleanedEvents: cleanParts.has(id) ? pitched(cleanParts.get(id)).length : 0,
  }));
  const rawHashAfter = sha256(await readFile(raw.path));
  const cleanHashAfter = sha256(await readFile(clean.path));
  return {
    filename: entry.filename,
    jobId: entry.jobId,
    inputSnapshots: {
      rawPath: raw.path,
      rawSha256: raw.hash,
      cleanPath: clean.path,
      cleanSha256: clean.hash,
    },
    snapshotsStableDuringAudit: raw.hash === rawHashAfter && clean.hash === cleanHashAfter,
    sourceObjectsUnchanged:
      before.raw === sha256(JSON.stringify(raw.project)) &&
      before.clean === sha256(JSON.stringify(clean.project)),
    groundTruthAvailable: false,
    stageCountChanges,
    stageCountScope:
      'Raw-to-clean differences are upstream model/decoder proposals, NOT engraving loss and NOT confirmed incorrect notes. Both complete snapshots are audited independently.',
    upstreamTransforms: clean.project.source.analysis?.transforms ?? [],
    stages,
    arrangement,
    manualReadabilityProjections: candidates,
    guardedReadabilitySuggestion: guardedReadabilitySuggestion ?? null,
    passed: Object.values(stages).every((stage) => stage.passed) && candidates.sourceUnchanged,
  };
}

let report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  scope:
    'Independent symbolic data-fidelity and notation-complexity audit on user full-song outputs; no transcription ground truth, no listening/visual acceptance, no user source changes.',
  comparisons: {
    eventTuple: ['MIDI pitch', 'absolute quarter-note beat onset', 'quarter-note beat duration'],
    tuplePrecisionBeats: 0.000001,
    multiplicityPreserved: true,
    audibleEventsIncludePercussion: true,
    complexity:
      'Counts parsed written note/chord groups, pitch heads, visible rest glyphs and tie starts. Not raw SVG path count or a human readability rating.',
    subSixteenth:
      'Written segment duration under .25 quarter-note beats (32nd-note units or shorter); physical duration depends on the displayed BPM.',
    noNormalizationOrClampingInsideChecker: true,
  },
  checkerSelfTests,
  checkerSha256,
  sourceModuleSha256: moduleHashes,
  moduleFingerprint,
  results: [],
};
try {
  const existing = JSON.parse(await readFile(outputPath, 'utf8'));
  if (
    existing.schemaVersion === report.schemaVersion &&
    existing.moduleFingerprint === moduleFingerprint &&
    existing.checkerSha256 === checkerSha256
  )
    report.results = existing.results ?? [];
} catch {
  /* First run has no prior report. */
}

async function saveReport() {
  report.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
}

try {
  const deadline = Date.now() + watchTimeoutSeconds * 1000;
  for (;;) {
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    report.manifestPath = manifestPath;
    report.manifestSha256 = sha256(manifestBytes);
    report.expectedInputs = manifest.inputs ?? [];
    const entries = (manifest.results ?? []).filter((entry) => entry.projectPath && entry.rawProjectPath);
    const ids = new Set(entries.map((entry) => entry.jobId));
    report.results = report.results.filter((result) => ids.has(result.jobId));
    for (const entry of entries) {
      const existing = report.results.find((result) => result.jobId === entry.jobId);
      const rawHash = sha256(await readFile(path.resolve(ROOT, entry.rawProjectPath)));
      const cleanHash = sha256(await readFile(path.resolve(ROOT, entry.projectPath)));
      if (
        existing?.inputSnapshots?.rawSha256 === rawHash &&
        existing?.inputSnapshots?.cleanSha256 === cleanHash &&
        existing.snapshotsStableDuringAudit
      )
        continue;
      console.log(`Auditing ${entry.filename} (${entry.jobId})`);
      try {
        const result = await auditSong(entry);
        report.results = report.results.filter((item) => item.jobId !== entry.jobId);
        report.results.push(result);
        console.log(
          JSON.stringify({
            song: entry.filename,
            symbolicPassed: result.passed,
            bestExactSecondsCandidate: result.manualReadabilityProjections.bestExactSecondsCandidate,
          }),
        );
      } catch (error) {
        report.results = report.results.filter((item) => item.jobId !== entry.jobId);
        report.results.push({
          filename: entry.filename,
          jobId: entry.jobId,
          passed: false,
          error: String(error.stack ?? error),
        });
      }
      await saveReport();
    }
    const expectedFilenames = (manifest.inputs ?? []).map((input) => input.filename);
    report.pendingInputs = expectedFilenames.filter(
      (filename) => !report.results.some((result) => result.filename === filename),
    );
    report.auditComplete = expectedFilenames.length > 0 && !report.pendingInputs.length;
    report.allCompletedStagesPassed =
      report.results.length > 0 &&
      report.results.every(
        (result) => result.passed && result.snapshotsStableDuringAudit && result.sourceObjectsUnchanged,
      );
    const completedViews = report.results.flatMap((result) => Object.values(result.stages ?? {}));
    report.summary = {
      completedSongs: report.results.length,
      sourceStageViews: completedViews.length,
      sourceStageEvents: completedViews.reduce((sum, stage) => sum + (stage.notes ?? 0), 0),
      allSourceStageEventsExactAbcAndXml: report.allCompletedStagesPassed,
      guardedReadingUnitSuggestions: report.results
        .filter((result) => result.guardedReadabilitySuggestion)
        .map((result) => ({ filename: result.filename, ...result.guardedReadabilitySuggestion })),
      explicitWarning:
        'Passing symbol tests do not validate the transcription notes or the musical quality of generated SATB; disclosures and octave/breath edits remain in per-song records.',
    };
    report.status = report.auditComplete
      ? report.allCompletedStagesPassed
        ? 'complete'
        : 'complete_with_findings'
      : 'partial_waiting_for_source_jobs';
    await saveReport();
    if (report.auditComplete || !watch || Date.now() >= deadline) break;
    await sleep(intervalSeconds * 1000);
  }
  if (alternativesPath) {
    report.optionalDecoderAlternatives = await auditAlternatives(alternativesPath);
    report.optionalDecoderAlternatives.allPassed = report.optionalDecoderAlternatives.results.every(
      (result) =>
        !result.error &&
        result.optionalProjectAudit.passed &&
        result.otherPartsExact.every((part) => part.entirePartUnchanged) &&
        result.originalAudioReferenceUnchanged &&
        result.sourceObjectUnchanged &&
        result.alternativeFileStable,
    );
    await saveReport();
  }
  console.log(
    JSON.stringify({
      report: outputPath,
      auditedSongs: report.results.length,
      pendingInputs: report.pendingInputs,
      status: report.status,
    }),
  );
} finally {
  await server.close();
  await rm(cacheDirectory, { recursive: true, force: true });
}
