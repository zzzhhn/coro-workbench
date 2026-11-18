// Make a stable local listening order. Write once: ratings are keyed to this round.
import { randomInt, randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkFreeze } from './audition-freeze.mjs';

const [corpusPath, manifestPath, ...ids] = process.argv.slice(2);
if (!corpusPath || !manifestPath)
  throw Error('Expected corpus.json, new manifest path, and optional candidate IDs');
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const { dev } = corpus;
const sealed = ids[0] === '--frozen';
let stage, freeze;
if (sealed) {
  stage = ids[2] ?? 'first';
  if (!ids[1] || ids.length > 3 || !['first', 'r1', 'r2'].includes(stage))
    throw Error('Expected --frozen RECEIPT [first|r1|r2]');
  freeze = JSON.parse(await readFile(ids[1], 'utf8'));
  await checkFreeze(freeze, corpus);
}
const blind = !sealed && ids.length > 0;
if (!sealed && (new Set(ids).size !== ids.length || ids.some((id) => !dev.some((r) => r.id === id))))
  throw Error('Unknown or duplicated development work');
if (ids.length === 1) throw Error('A planning comparison needs at least two distinct works');
const songs = [];
for (const s of sealed ? corpus.holdout : dev.filter((r) => !ids.length || ids.includes(r.id))) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id)) throw Error('Invalid work ID');
  const versions = [
    {
      dir: (sealed ? stage : 'drafts') + '/' + s.id,
      identity: sealed ? '留出评测 · ' + stage : 'V2 规则计划',
    },
  ];
  if (blind) {
    versions.push({ dir: 'candidates/' + s.id, identity: '模型计划，共用 V2 落谱器' });
    if (randomInt(2)) versions.reverse();
  }
  for (const version of versions) {
    const dir = join(dirname(manifestPath), version.dir);
    await Promise.all(
      [
        'arrangement.json',
        'score.musicxml',
        'score.coro',
        'audio.json',
        'mix.m4a',
        'solo.m4a',
        's.m4a',
        'a.m4a',
        't.m4a',
        'b.m4a',
      ].map((file) => access(join(dir, file))),
    );
  }
  const directory = join(dirname(manifestPath), versions[0].dir);
  let issue;
  if (sealed) {
    const file = stage === 'first' && freeze.policy.mode === 'rule' ? 'evidence.json' : 'decision.json';
    const receipt = JSON.parse(await readFile(join(directory, file), 'utf8'));
    if (
      receipt.sourceSha256 !== s.sourceSha256 ||
      JSON.stringify(receipt.freeze) !== JSON.stringify(freeze) ||
      (receipt.calibration?.round ?? 0) !== ['first', 'r1', 'r2'].indexOf(stage)
    )
      throw Error('留出版本与冻结记录或校准轮次不符。');
  } else if (!blind) {
    issue = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')).issue;
  }
  songs.push({
    id: s.id,
    title: s.title,
    feature: s.feature,
    issue,
    versions: versions.map((v, i) => ({
      ...v,
      label: blind ? ['A', 'B'][i] : sealed && stage !== 'first' ? '校准 ' + stage.slice(1) : '初稿',
    })),
  });
}
if (!songs.length) throw Error('No development drafts to review');
await writeFile(manifestPath, JSON.stringify({ roundId: randomUUID(), songs }, null, 2), { flag: 'wx' });
