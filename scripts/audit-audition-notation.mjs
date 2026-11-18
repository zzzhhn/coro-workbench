import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import abcjs from 'abcjs';
import { XMLParser } from 'fast-xml-parser';
import { createServer } from 'vite';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const exporterFiles = ['src/lib/music.ts', 'src/lib/engraving.ts', 'src/lib/midiNotation.ts'];
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rounded = (n) => Number(n.toFixed(7));
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) < tolerance;
const xmlTypes = new Map(['breve', 'whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th', '128th', '256th']
  .map((type, index) => [type, 8 / 2 ** index]));
const abcWrittenValues = [16, ...xmlTypes.values()].flatMap((base) =>
  [0, 1, 2, 3, 4].map((dots) => ({ dots, duration: base * (2 - 1 / 2 ** dots) })));
const wholeBar = (project) => project.timeSignature[0] * 4 / project.timeSignature[1];

async function versions(manifests, allowVersion) {
  const byHash = new Map();
  for (const manifest of manifests) {
    const manifestPath = path.resolve(root, manifest);
    for (const song of (await readJson(manifestPath)).songs) {
      for (const version of song.versions) {
        const source = await realpath(path.resolve(path.dirname(manifestPath), version.dir, 'arrangement.json'));
        if (allowVersion && !allowVersion(song.id, source))
          throw new Error(`Refused by development manifest scope: ${source}`);
        const bytes = await readFile(source);
        const sha256 = digest(bytes);
        const alias = { manifest, label: version.label, file: path.relative(root, source) };
        if (!byHash.has(sha256)) byHash.set(sha256, {
          songId: song.id, title: song.title, project: JSON.parse(bytes), sha256, aliases: [],
        });
        byHash.get(sha256).aliases.push(alias);
      }
    }
  }
  return [...byHash.values()];
}

function abcRows(tune, result, length) {
  const rows = [];
  const clocks = [];
  for (const [index, line] of tune.lines.filter((line) => line.staff).entries()) {
    for (const [staffIndex, staff] of line.staff.entries()) {
      const mapping = result.staffMap[staffIndex];
      for (const [voiceIndex, voice] of staff.voices.entries()) {
        const lane = mapping.voiceIds[voiceIndex];
        if (!lane || !/^P\d/.test(lane)) continue;
        let measure = result.systemMeasures[index];
        let start = 0;
        let running;
        for (const event of voice) {
          if (event.el_type === 'bar') {
            if (!close(start, length)) clocks.push([mapping.partId, lane, measure, rounded(start - length)]);
            measure++;
            start = 0;
          }
          if (event.el_type !== 'note' || !event.duration) continue;
          if (event.startTriplet) {
            running = {
              actual: event.startTriplet,
              normal: Math.round(event.startTriplet * event.tripletMultiplier),
              size: event.tripletR,
            };
          }
          const mapped = result.noteSegments[event.startChar];
          const type = event.rest ? 'rest' : 'note';
          const hidden = ['invisible', 'spacer'].includes(event.rest?.type);
          const written = event.duration * 4;
          const dots = abcWrittenValues.find((value) => close(value.duration, written))?.dots;
          const duration = written * (running ? running.normal / running.actual : 1);
          rows.push({
            part: mapping.partId, lane, measure, start, duration, written, dots, type, hidden,
            heads: event.pitches?.length ?? 0,
            tieIn: event.pitches?.some((p) => p.endTie) ?? false,
            tieOut: event.pitches?.some((p) => p.startTie) ?? false,
            ...(running ? { ratio: `${running.actual}:${running.normal}`, tupletSize: running.size } : {}),
            ...(event.startTriplet ? { tupletStart: true } : {}),
            ...(event.endTriplet ? { tupletEnd: true } : {}),
            ...(mapped ? { noteIds: mapped.noteIds } : {}),
          });
          start += duration;
          if (event.endTriplet) running = undefined;
        }
      }
    }
  }
  return { rows, clocks };
}

const child = (nodes, tag) => nodes?.find((node) => Object.hasOwn(node, tag))?.[tag];
const children = (nodes, tag) => nodes?.filter((node) => Object.hasOwn(node, tag)) ?? [];
const value = (nodes, tag) => child(nodes, tag)?.[0]?.['#text'];
const attr = (node, key) => node[':@']?.[`@_${key}`];
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false });
function xmlRows(xml, project, length) {
  const rows = [];
  const clocks = [];
  const parts = children(child(parser.parse(xml), 'score-partwise'), 'part');
  for (const [partIndex, part] of parts.entries()) {
    const partId = project.parts[partIndex].id;
    let divisions = 1;
    for (const measureNode of children(part.part, 'measure')) {
      const measure = Number(attr(measureNode, 'number'));
      let start = 0;
      let previous;
      let lane;
      for (const element of measureNode.measure) {
        if (element.attributes) divisions = Number(value(element.attributes, 'divisions') ?? divisions);
        if (element.backup) {
          if (!close(start, length)) clocks.push([partId, lane, measure, rounded(start - length)]);
          start -= Number(value(element.backup, 'duration')) / divisions;
        }
        if (element.forward) start += Number(value(element.forward, 'duration')) / divisions;
        const note = element.note;
        if (!note || child(note, 'grace')) continue;
        lane = `staff${value(note, 'staff') ?? 1}/voice${value(note, 'voice') ?? 1}`;
        if (child(note, 'chord')) {
          if (!previous) throw new Error('MusicXML chord without anchor');
          previous.heads++;
          continue;
        }
        const duration = Number(value(note, 'duration')) / divisions;
        const writtenType = value(note, 'type');
        const dots = children(note, 'dot').length;
        const rest = children(note, 'rest')[0];
        const written = rest && attr(rest, 'measure') === 'yes' ? length
          : xmlTypes.get(writtenType) * (2 - 1 / 2 ** dots);
        const type = rest ? 'rest' : 'note';
        const ratio = child(note, 'time-modification');
        const tuplet = children(child(note, 'notations'), 'tuplet');
        previous = {
          part: partId, lane, measure, start, duration, written, writtenType, dots, type,
          heads: type === 'note' ? 1 : 0, hidden: attr(element, 'print-object') === 'no',
          tieIn: children(note, 'tie').some((tie) => attr(tie, 'type') === 'stop'),
          tieOut: children(note, 'tie').some((tie) => attr(tie, 'type') === 'start'),
          ...(ratio ? { ratio: `${value(ratio, 'actual-notes')}:${value(ratio, 'normal-notes')}` } : {}),
          ...(tuplet.some((item) => attr(item, 'type') === 'start') ? { tupletStart: true } : {}),
          ...(tuplet.some((item) => attr(item, 'type') === 'stop') ? { tupletEnd: true } : {}),
        };
        rows.push(previous);
        start += duration;
      }
      if (!close(start, length)) clocks.push([partId, lane, measure, rounded(start - length)]);
    }
  }
  return { rows, clocks };
}

function layoutGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.part}|${row.lane}|${row.measure}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function scan(rows, format, measureBeats) {
  const counts = {};
  const measures = [];
  const allRatios = {};
  const add = (dict, key) => { dict[key] = (dict[key] ?? 0) + 1; };
  let minNoteBeats = Infinity;
  let minRestBeats = Infinity;
  for (const group of layoutGroups(rows).values()) {
    const rests = [];
    for (const row of group) {
      if (!row.hidden) {
        add(counts, `visible-${row.type}`);
        if (row.type === 'note') minNoteBeats = Math.min(minNoteBeats, row.duration);
        else minRestBeats = Math.min(minRestBeats, row.duration);
      }
      if (row.ratio && !row.hidden) add(allRatios, row.ratio);
      row.flags = [];
      if (row.hidden) continue;
      if (row.type === 'rest') rests.push(row);
      else {
        if (rests.length >= 3) for (const rest of rests) rest.flags.push('rest-run');
        rests.length = 0;
      }
      if (row.duration < 1 / 8 - 1e-6) row.flags.push(`short-${row.type}`);
      if (row.duration < 1 / 16 - 1e-6) row.flags.push(`shorter-than-64th-${row.type}`);
      if (row.duration < 1 / 32 - 1e-6) row.flags.push(`shorter-than-128th-${row.type}`);
      if (row.type === 'note' && (row.tieIn || row.tieOut) && row.duration < 1 / 8 - 1e-6)
        row.flags.push(row.start < 1e-6 || close(row.start + row.duration, measureBeats) ? 'short-barline-tie' : 'short-internal-tie');
      const [actual = 1, normal = 1] = row.ratio?.split(':').map(Number) ?? [];
      if (row.ratio && row.ratio !== '3:2') row.flags.push('unusual-ratio');
      if (format === 'abc' && row.dots === undefined) row.flags.push('irregular-abc-fraction');
      if (format === 'xml' && (!Number.isFinite(row.written) || !close(row.written * normal / actual, row.duration, 1e-5)))
        row.flags.push('xml-written-clock-mismatch');
      if (row.dots > 1) row.flags.push('multiple-dots');
      if (row.dots > 2 || (row.dots > 1 && row.duration < 1 / 8))
        row.flags.push('unusual-multiple-dots');
    }
    if (rests.length >= 3) for (const rest of rests) rest.flags.push('rest-run');
    for (let index = 0; index < group.length; index++) {
      const row = group[index];
      if (row.ratio !== '3:2' || row.hidden) continue;
      const contiguous = (events, size) => events.length === size && events.every((event, i) =>
        !event.hidden && event.ratio === '3:2' &&
        (!i || close(event.start, events[i - 1].start + events[i - 1].duration)));
      const three = group.slice(index, index + 3);
      const two = group.slice(index, index + 2);
      const matching = [
        ...(contiguous(three, 3) && three.every((event) => close(event.duration, row.duration)) ? [three] : []),
        ...(contiguous(two, 2) && close(Math.max(row.duration, two[1].duration), 2 * Math.min(row.duration, two[1].duration)) ? [two] : []),
      ];
      const stop = row.tupletStart ? group.findIndex((event, i) => i >= index && event.tupletEnd) : -1;
      const bracket = stop > index ? group.slice(index, stop + 1) : [];
      const declared = contiguous(bracket, bracket.length) && bracket.length > 1 ? bracket : undefined;
      const inferred = format === 'xml' && !row.tupletStart ? matching[0] : undefined;
      const tuplet = declared ?? inferred;
      if (!tuplet || (format === 'abc' && tuplet.length !== row.tupletSize)) {
        row.flags.push('isolated-3:2');
        continue;
      }
      // Two independent attacks, or a rest and an independent attack, support a rhythmic figure.
      // A group made only from tied residues is a spelling artifact even when the ratio is 3:2.
      const rhythmicEvents = tuplet.filter((event) => event.type === 'rest' || !event.tieIn);
      const metric = rhythmicEvents.length >= 2 && rhythmicEvents.some((event) => event.type === 'note');
      for (const event of tuplet) {
        event.flags.push(metric ? 'metric-triplet' : 'triplet-made-from-fragments');
        if (inferred) event.flags.push('unbracketed-triplet-candidate');
      }
      index += tuplet.length - 1;
    }
    const flagged = group.filter((row) => row.flags.length);
    for (const row of flagged) for (const flag of row.flags) add(counts, flag);
    if (flagged.length) measures.push({
      part: group[0].part, lane: group[0].lane, measure: group[0].measure,
      events: flagged.map(({ start, duration, written, type, flags, ratio, dots, tieIn, tieOut, noteIds }) =>
        ({ beat: rounded(start + 1), duration: rounded(duration), written, type, flags,
          ...(ratio ? { ratio } : {}), ...(dots ? { dots } : {}),
          ...(tieIn || tieOut ? { ties: [tieIn, tieOut] } : {}), ...(noteIds ? { noteIds } : {}) })),
    });
  }
  return { counts, allRatios, minNoteBeats: rounded(minNoteBeats), minRestBeats: rounded(minRestBeats), measures };
}

function compare(expected, actual) {
  const left = new Map();
  const right = new Map();
  for (const [events, map] of [[expected, left], [actual, right]]) {
    for (const event of events) {
      const key = JSON.stringify(event);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  const residual = (a, b) => [...a].filter(([key, n]) => n > (b.get(key) ?? 0))
    .map(([key, n]) => [JSON.parse(key), n - (b.get(key) ?? 0)]);
  const missing = residual(left, right);
  const extra = residual(right, left);
  return {
    expected: expected.length, actual: actual.length,
    missing: missing.reduce((sum, [, n]) => sum + n, 0), extra: extra.reduce((sum, [, n]) => sum + n, 0),
    missingExamples: missing.slice(0, 5), extraExamples: extra.slice(0, 5),
  };
}

const tuple = (note) => [note.midi, rounded(note.start), rounded(note.duration)];
const pitched = (part) => part?.notes.filter((note) => note.midi !== null).map(tuple) ?? [];
const glyph = (row) => [row.measure, rounded(row.start), rounded(row.duration), row.type, row.heads];
const ticks = (events, usePitch = true) => events.map(([midi, start, duration]) => [
  ...(usePitch ? [midi] : []), Math.round(start * 960),
  Math.round((start + duration) * 960) - Math.round(start * 960),
]);
function abcAudio(tune, abc) {
  const decoded = new Map();
  const tracks = tune.setUpAudio({ chordsOff: true }).tracks;
  const mapping = abc.staffMap.flatMap((staff) => staff.voiceIds.map(() => staff.partId));
  if (mapping.length !== tracks.length) throw new Error('ABC audio tracks do not match staff mapping.');
  for (const [index, track] of tracks.entries()) {
    const part = mapping[index];
    if (!decoded.has(part)) decoded.set(part, []);
    for (const event of track) {
      if (event.cmd === 'note') decoded.get(part).push([event.pitch, rounded(event.start * 4), rounded(event.duration * 4)]);
    }
  }
  return decoded;
}

// Use the caller's Vite instance and return the same MusicXML bytes just audited.
export async function loadAuditionNotationAudit(vite) {
  const [music, engraving, midiNotation] = await Promise.all([
    vite.ssrLoadModule('/src/lib/music.ts'), vite.ssrLoadModule('/src/lib/engraving.ts'),
    vite.ssrLoadModule('/src/lib/midiNotation.ts'),
  ]);
  return (project) => {
    const len = wholeBar(project);
    const beforeHash = digest(JSON.stringify(project));
    const abc = music.toAbc(project);
    const tunes = abcjs.parseOnly(abc.abc);
    if (tunes.length !== 1) throw new Error(`Expected one ABC tune for ${project.title}, found ${tunes.length}.`);
    const [tune] = tunes;
    const abcRaw = abcRows(tune, abc, len);
    const decodedRaw = abcAudio(tune, abc);
    // Visual pruning removes empty auxiliary staves per system. Keep them for
    // linear synth track assignment while still applying pitch and tie preparation.
    const rendered = engraving.prepareEngravingTune(abcjs.parseOnly(abc.abc)[0], { ...abc, staffLayout: undefined });
    const decodedRendered = abcAudio(rendered, abc);
    const xml = music.toMusicXml(project);
    const fromXml = music.fromMusicXml(xml);
    const xmlNotated = xmlRows(xml, project, len);
    const projectNotation = midiNotation.projectArrangementNotation ?? midiNotation.projectMeasuredSoloNotation;
    const notation = projectNotation(project);
    const abcScan = scan(abcRaw.rows, 'abc', len);
    const xmlScan = scan(xmlNotated.rows, 'xml', len);
    const semantic = project.parts.map((part, index) => {
      const expected = pitched(notation.parts[index]);
      const raw = decodedRaw.get(part.id) ?? [];
      const prepared = decodedRendered.get(part.id) ?? [];
      const xmlEvents = pitched(fromXml.parts[index]);
      // ABC percussion symbols outside the explicit GM map retain their
      // display pitch until prepared. Check their pitch in prepared ABC and XML.
      const rawAbcPitchCompared = part.role !== 'percussion' ||
        expected.every(([midi]) => midi >= 35 && midi <= 81);
      return {
        part: part.id, rawAbcPitchCompared,
        writtenProjectionVsRaw: compare(pitched(part), expected),
        rawAbcVsProjection: compare(expected, raw),
        preparedAbcVsProjection: compare(expected, prepared),
        xmlVsProjection: compare(expected, xmlEvents),
        preparedAbcVsXml: compare(prepared, xmlEvents),
        preparedAbcVsXmlTicks: compare(ticks(prepared), ticks(xmlEvents)),
        rawAbcVsProjectionTicks: compare(ticks(expected, rawAbcPitchCompared), ticks(raw, rawAbcPitchCompared)),
        preparedAbcVsProjectionTicks: compare(ticks(expected), ticks(prepared)),
        xmlVsProjectionTicks: compare(ticks(expected), ticks(xmlEvents)),
        visibleAbcVsXml: compare(abcRaw.rows.filter((row) => row.part === part.id && !row.hidden).map(glyph),
          xmlNotated.rows.filter((row) => row.part === part.id && !row.hidden).map(glyph)),
      };
    });
    if (beforeHash !== digest(JSON.stringify(project))) throw new Error('An export mutated its source.');
    const report = {
      tempo: project.tempo, meter: project.timeSignature, measures: project.measures,
      abcSha256: digest(abc.abc), xmlSha256: digest(xml),
      abc: abcScan, xml: xmlScan, abcClockErrors: abcRaw.clocks, xmlClockErrors: xmlNotated.clocks,
      abcParseWarnings: tune.warnings ?? [], xmlImportWarnings: fromXml.source.warnings ?? [],
      semantic,
    };
    return { notation, report, xml, failures: notationFailures(report) };
  };
}

export async function auditAuditionNotation({ manifests, snapshotRef, allowVersion, extendCase }) {
  if (!manifests?.length) throw new Error('Supply at least one local audition manifest.');
  if (snapshotRef && !/^[0-9a-f]{7,40}$/.test(snapshotRef)) throw new Error('Use a full or abbreviated Git commit SHA.');
  const revision = execFileSync('git', ['rev-parse', snapshotRef ?? 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const readSnapshot = (file) => execFileSync('git', ['show', `${revision}:${file}`], { cwd: root });
  const exporterSha256 = Object.fromEntries(await Promise.all(exporterFiles.map(async (file) =>
    [file, digest(snapshotRef ? readSnapshot(file) : await readFile(path.join(root, file)))])));
  const plugins = !snapshotRef ? [] : [{
    name: 'audit-source-snapshot',
    enforce: 'pre',
    load(id) {
      const relative = path.relative(root, id.split('?')[0]);
      if (relative.startsWith('src/lib/') && relative.endsWith('.ts'))
        return readSnapshot(relative).toString('utf8');
    },
  }];
  const server = await createServer({
    root, configFile: false, plugins, logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, ws: false },
  });
  try {
    const audit = await loadAuditionNotationAudit(server);
    const report = {
      manifests, gitRevision: revision, sourceMode: snapshotRef ? 'git' : 'worktree',
      exporterSha256, cases: [], failures: [],
    };
    for (const { project, ...version } of await versions(manifests, allowVersion)) {
      const { notation, report: result, failures } = audit(project);
      const thisCase = { ...version, ...result };
      if (extendCase) Object.assign(thisCase, extendCase({ project, notation, report: thisCase }));
      report.cases.push(thisCase);
      report.failures.push(...failures.map((failure) => ({ file: version.aliases[0].file, ...failure })));
    }
    return report;
  } finally {
    await server.close();
  }
}

function notationFailures(score) {
  const checks = ['rawAbcVsProjectionTicks', 'preparedAbcVsProjectionTicks', 'xmlVsProjectionTicks', 'preparedAbcVsXmlTicks'];
  const clocks = [
    ['abc-measure-clock', score.abcClockErrors.length],
    ['xml-measure-clock', score.xmlClockErrors.length],
    ['xml-written-clock', score.xml.counts['xml-written-clock-mismatch'] ?? 0],
  ].flatMap(([check, count]) => count ? [{ check, count }] : []);
  const notes = score.semantic.flatMap((part) => checks.flatMap((check) => {
    const { missing, extra } = part[check];
    return missing || extra ? [{ part: part.part, check, missing, extra }] : [];
  }));
  return [...clocks, ...notes];
}

export function summarizeNotation(report) {
  return report.cases.map(({ title, aliases, measures, abc, xml, abcClockErrors, xmlClockErrors, abcParseWarnings, semantic }) => ({
    title, file: aliases[0].file, measures, abc: abc.counts, xml: xml.counts,
    abcMin: [abc.minNoteBeats, abc.minRestBeats], xmlMin: [xml.minNoteBeats, xml.minRestBeats],
    abcClockErrors: abcClockErrors.length, xmlClockErrors: xmlClockErrors.length,
    abcParseWarnings: abcParseWarnings.length,
    abcXmlDifferentEvents: semantic.reduce((sum, row) => sum + row.preparedAbcVsXmlTicks.missing + row.preparedAbcVsXmlTicks.extra, 0),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string', multiple: true },
    out: { type: 'string' },
    revision: { type: 'string' },
    check: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/audit-audition-notation.mjs --manifest path/to/manifest.json [--manifest path/to/other.json] --out path/to/report.json [--revision <git-sha>] [--check]');
    console.log('Each manifest lists songs with id, title and versions. Each version has label and a dir containing arrangement.json, relative to the manifest.');
    console.log('--check exits 1 for measure clock or note-event mismatches. Short values and unusual tuplet ratios are reported for review.');
  } else {
    if (!values.out) throw new Error('Supply --out to save the detailed measure audit.');
    const report = await auditAuditionNotation({ manifests: values.manifest?.map((input) => path.resolve(input)), snapshotRef: values.revision });
    const output = path.resolve(values.out);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report) + '\n');
    console.log(JSON.stringify(summarizeNotation(report), null, 2));
    if (values.check && report.failures.length) {
      console.error(`${report.failures.length} notation checks failed. See ${output}`);
      process.exitCode = 1;
    }
  }
}
