// node scripts/realize-form-audition.mjs SOURCE.json CURRENT_ARRANGEMENT.json NEW_DIR [SUBMISSION.json]
import { readFile, mkdir, writeFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { formBrief } from './form-brief.mjs';

const [sourcePath, currentPath, destination, submissionPath] = process.argv.slice(2);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const source = await read(sourcePath);
const current = await read(currentPath);
if (!['groove', 'lyrical'].includes(current.arrangement.options.engine) || current.arrangement.locks?.length)
  throw Error('Use an unlocked groove or lyrical draft.');
const options = { ...current.arrangement.options };
delete options.formPlan;
delete source.source.arrangementSections;
const brief = formBrief(source, options.leadPartId);
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, watch: null, ws: false },
  optimizeDeps: { noDiscovery: true },
});
try {
  const { wholeSongPlan } = await server.ssrLoadModule('/src/lib/auditionPlan.ts');
  const { generateArrangementVersion } = await server.ssrLoadModule('/src/lib/arrangementVersions.ts');
  const { createProjectBundle, importProjectBundle } =
    await server.ssrLoadModule('/src/lib/projectBundle.ts');
  const { toMusicXml } = await server.ssrLoadModule('/src/lib/music.ts');
  if (submissionPath) {
    const submission = await read(submissionPath);
    assert.equal(submission.inputSHA256, brief.inputSHA256, 'Planner input mismatch');
    const plan = wholeSongPlan(source.measures, submission.sections, submission.model);
    options.formPlan = { inputSHA256: brief.inputSHA256, model: plan.model, sections: plan.sections };
  }
  const { project } = generateArrangementVersion(source, options);
  assert.equal(project.arrangement.plan.planner, submissionPath ? 'model' : 'rule');
  const events = (p) => p.parts[0].notes.map(({ id, ...note }) => note);
  assert.deepEqual(events(project), events(current));
  assert.deepEqual(project.timeSignature, current.timeSignature);
  assert.equal(project.tempo, current.tempo);
  const bytes = await createProjectBundle(
    { source, arrangement: project, active: 'arrangement', savedAt: new Date().toISOString() },
    false,
  );
  const restored = await importProjectBundle(new File([bytes], 'score.coro'));
  assert.ok(
    generateArrangementVersion(
      restored.source,
      restored.arrangement.arrangement.options,
      restored.arrangement,
    ).identical,
  );
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), '.form-'));
  try {
    for (const [file, data] of Object.entries({
      'score.coro': bytes,
      'score.musicxml': toMusicXml(project),
      'source.json': JSON.stringify(source),
      'arrangement.json': JSON.stringify(project),
      'evidence.json': JSON.stringify(
        { inputSHA256: brief.inputSHA256, plan: project.arrangement.plan },
        null,
        2,
      ),
    }))
      await writeFile(join(stage, file), data);
    await rename(stage, destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
} finally {
  await server.close();
}
