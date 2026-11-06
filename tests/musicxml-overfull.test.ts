import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { fromMusicXml, toAbc, toMusicXml, validateProject } from '../src/lib/music';
import { prepareEngravingTune } from '../src/lib/engraving';
import abcjs from 'abcjs';

const header =
  '<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';
const pitched = (step: string, duration: number) =>
  `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration * 2}</duration></note>`;
const wrap = (first: string, second?: string) =>
  `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Part One</part-name></score-part>${second ? '<score-part id="P2"><part-name>Part Two</part-name></score-part>' : ''}</part-list><part id="P1">${first}</part>${second ? `<part id="P2">${second}</part>` : ''}</score-partwise>`;
const fingerprint = (notes: Array<{ midi: number | null; start: number; duration: number }>) =>
  notes.filter((note) => note.midi !== null).map((note) => [note.midi, note.start, note.duration]);

describe('MusicXML overfull measures preserve notes without timeline drift', () => {
  it('uses nominal next-bar onsets for every part while preserving an overhanging note', () => {
    const malformed = `<measure number="1">${header}${pitched('C', 5)}</measure><measure number="2">${pitched('D', 4)}</measure><measure number="3">${pitched('E', 4)}</measure>`;
    const normal = `<measure number="1">${header}${pitched('G', 4)}</measure><measure number="2">${pitched('A', 4)}</measure><measure number="3">${pitched('B', 4)}</measure>`;
    const result = fromMusicXml(wrap(malformed, normal));
    expect(fingerprint(result.parts[0].notes)).toEqual([
      [60, 0, 5],
      [62, 4, 4],
      [64, 8, 4],
    ]);
    expect(fingerprint(result.parts[1].notes)).toEqual([
      [67, 0, 4],
      [69, 4, 4],
      [71, 8, 4],
    ]);
    expect(result.measures).toBe(3);
    expect(result.source.warnings.join('')).toContain('Part One 第 1 小节记有 5 拍');
    expect(result.source.warnings.join('')).toContain('后续小节仍按拍号对齐');
    expect(validateProject(result)).toEqual([]);
    expect(fingerprint(fromMusicXml(toMusicXml(result)).parts[0].notes)).toEqual(
      fingerprint(result.parts[0].notes),
    );
  });

  it('keeps late onsets, explicit rests and multiple overfull bars instead of clipping them', () => {
    const measures = `<measure number="1">${header}${pitched('C', 4)}${pitched('D', 1.5)}</measure><measure number="2"><note><rest/><duration>10</duration></note></measure><measure number="3">${pitched('E', 1)}</measure>`;
    const result = fromMusicXml(wrap(measures));
    expect(result.parts[0].notes.map((note) => [note.midi, note.start, note.duration])).toEqual([
      [60, 0, 4],
      [62, 4, 1.5],
      [null, 4, 5],
      [64, 8, 1],
    ]);
    expect(result.source.warnings.filter((warning) => warning.includes('超过拍号'))).toHaveLength(2);
    expect(result.measures).toBe(3);
  });

  it('extends only the project tail when the final note exceeds the last nominal measure', () => {
    const result = fromMusicXml(
      wrap(
        `<measure number="1">${header}${pitched('C', 4)}</measure><measure number="2">${pitched('D', 7)}</measure>`,
      ),
    );
    expect(fingerprint(result.parts[0].notes)).toEqual([
      [60, 0, 4],
      [62, 4, 7],
    ]);
    expect(result.measures).toBe(3);
    expect(validateProject(result)).toEqual([]);
  });

  it('honors a real short implicit pickup rather than filling it to the nominal meter', () => {
    const first = `<measure number="0" implicit="yes">${header}${pitched('C', 1)}</measure><measure number="1">${pitched('D', 4)}</measure><measure number="2">${pitched('E', 4)}</measure>`;
    const second = `<measure number="0" implicit="yes">${header}${pitched('G', 1)}</measure><measure number="1">${pitched('A', 4)}</measure><measure number="2">${pitched('B', 4)}</measure>`;
    const result = fromMusicXml(wrap(first, second));
    expect(fingerprint(result.parts[0].notes)).toEqual([
      [60, 0, 1],
      [62, 1, 4],
      [64, 5, 4],
    ]);
    expect(fingerprint(result.parts[1].notes)).toEqual([
      [67, 0, 1],
      [69, 1, 4],
      [71, 5, 4],
    ]);
    expect(result.source.warnings.join('')).toContain('弱起小节');
    expect(result.source.warnings.join('')).not.toContain('超过拍号');
  });

  it('does not mistake an overfull implicit measure or an underfull ordinary measure for a pickup', () => {
    const result = fromMusicXml(
      wrap(
        `<measure number="1" implicit="yes">${header}${pitched('C', 5)}</measure><measure number="2">${pitched('D', 1)}</measure><measure number="3">${pitched('E', 1)}</measure>`,
      ),
    );
    expect(fingerprint(result.parts[0].notes)).toEqual([
      [60, 0, 5],
      [62, 4, 1],
      [64, 8, 1],
    ]);
    expect(result.source.warnings.join('')).not.toContain('弱起小节');
    expect(result.source.warnings.join('')).toContain('超过拍号');
  });
});

const manifest = 'evidence/omr-validation.json';
const dataDirectory = existsSync(manifest)
  ? (JSON.parse(readFileSync(manifest, 'utf8')) as { dataDirectory: string }).dataDirectory
  : '';
const fixtureExists =
  dataDirectory &&
  ['generated-pdf', 'generated-png', 'public-scan'].every((name) =>
    existsSync(join(dataDirectory, `${name}.musicxml`)),
  );

describe.skipIf(!fixtureExists)('Actual Audiveris local recognition output', () => {
  it.each([
    { name: 'generated-pdf', measures: 16, canonicalNotes: 431, overfull: 2 },
    { name: 'generated-png', measures: 8, canonicalNotes: 221, overfull: 3 },
  ])('$name keeps all notes and nominal drum onset grid', (fixture) => {
    const xml = readFileSync(join(dataDirectory, `${fixture.name}.musicxml`), 'utf8');
    const project = fromMusicXml(xml);
    expect(project.measures).toBe(fixture.measures);
    expect(project.parts.reduce((sum, part) => sum + part.notes.length, 0)).toBe(fixture.canonicalNotes);
    expect(project.source.warnings.filter((warning) => warning.includes('超过拍号'))).toHaveLength(
      fixture.overfull,
    );
    expect(validateProject(project)).toEqual([]);

    // Independent ordered-XML traversal: the malformed drum part has no ties,
    // so its every source note onset/duration is directly auditable by bar index.
    type Node = Record<string, unknown>;
    const tree = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false }).parse(
      xml,
    ) as Node[];
    const tag = (node: Node) => Object.keys(node).find((key) => key !== ':@')!;
    const children = (node: Node) => node[tag(node)] as Node[];
    const child = (node: Node, name: string) => children(node).find((node) => tag(node) === name);
    const text = (node: Node | undefined): string =>
      !node ? '' : tag(node) === '#text' ? String(node['#text']) : children(node).map(text).join('');
    const root = tree.find((node) => tag(node) === 'score-partwise')!;
    const drumPart = children(root)
      .filter((node) => tag(node) === 'part')
      .at(-1)!;
    let divisions = 1;
    const expected: Array<[number, number]> = [];
    children(drumPart)
      .filter((node) => tag(node) === 'measure')
      .forEach((measure, index) => {
        let cursor = 0;
        let previous = 0;
        for (const element of children(measure)) {
          if (tag(element) === 'attributes' && child(element, 'divisions'))
            divisions = Number(text(child(element, 'divisions')));
          const duration = Number(text(child(element, 'duration'))) / divisions;
          if (tag(element) === 'backup') cursor -= duration;
          if (tag(element) === 'forward') cursor += duration;
          if (tag(element) !== 'note') continue;
          const chord = Boolean(child(element, 'chord'));
          const start = chord ? previous : cursor;
          if (child(element, 'unpitched')) expected.push([index * 4 + start, duration]);
          if (!chord) {
            previous = cursor;
            cursor += duration;
          }
        }
      });
    const actual = project.parts
      .at(-1)!
      .notes.filter((note) => note.midi !== null)
      .map((note) => [note.start, note.duration]);
    const order = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1];
    expect(actual.sort(order)).toEqual(expected.sort(order));
    const result = toAbc(project);
    const tune = prepareEngravingTune(abcjs.parseOnly(result.abc)[0], result);
    expect(tune.warnings ?? []).toEqual([]);
    expect(tune.setUpAudio({ chordsOff: true }).totalDuration * 4).toBe(fixture.measures * 4);
  });

  it('does not change the valid public-domain grand-staff import', () => {
    const project = fromMusicXml(readFileSync(join(dataDirectory, 'public-scan.musicxml'), 'utf8'));
    expect(project.measures).toBe(17);
    expect(project.timeSignature).toEqual([2, 4]);
    expect(project.parts).toHaveLength(1);
    expect(project.parts[0].staves).toHaveLength(2);
    expect(project.source.warnings.some((warning) => warning.includes('超过拍号'))).toBe(false);
  });
});
