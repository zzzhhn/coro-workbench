// Print evidence for the planner, or realize its independently supplied decisions.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { checkFreeze } from './audition-freeze.mjs';
import { publishScore } from './audition-score.mjs';

const [draftDir, decisionFile, out, parentDir] = process.argv.slice(2);
if (!draftDir || Boolean(decisionFile) !== Boolean(out))
  throw Error('Usage: node scripts/plan-audition.mjs DRAFT [DECISIONS.json NEW_DIR [PREVIOUS_CANDIDATE]]');
const load = async (path) => JSON.parse(await readFile(path, 'utf8'));
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  appType: 'custom',
});
try {
  const { accompanimentBreaks, planAccompanimentBreaks } = await vite.ssrLoadModule(
    '/src/lib/accompanimentBreaks.ts',
  );
  const source = await load(join(draftDir, 'source.json'));
  const baseline = await load(join(draftDir, 'arrangement.json'));
  const { options, plan } = baseline.arrangement;
  if (
    options.engine !== 'v2' ||
    options.preset !== 'solo-satb' ||
    plan.planner !== 'rule' ||
    baseline.arrangement.locks?.length
  )
    throw Error('Expected an unmodified V2 Solo + SATB rule draft.');
  const spans = accompanimentBreaks(source, options.leadPartId);
  const { sourceSha256, freeze } = await load(join(draftDir, 'evidence.json'));
  if (freeze) await checkFreeze(freeze);
  const { describeScore } = await vite.ssrLoadModule('/src/lib/arrangementBrief.ts');
  if (!decisionFile)
    console.log(
      JSON.stringify(
        {
          title: source.title,
          sourceSha256,
          policy: freeze?.policy,
          ...describeScore(source, options.leadPartId),
          spans,
        },
        null,
        2,
      ),
    );
  else {
    const decisionBytes = await readFile(decisionFile);
    const submission = JSON.parse(decisionBytes);
    if (submission.sourceSha256 !== sourceSha256)
      throw Error('Planner brief and draft are from different sources.');
    if (Boolean(submission.sections) === Boolean(submission.decisions))
      throw Error('Choose one experiment: whole-song plan or break decisions.');
    const { wholeSongPlan } = await vite.ssrLoadModule('/src/lib/auditionPlan.ts');
    const expectedMode = parentDir
      ? (freeze?.policy.calibrationMode ?? freeze?.policy.mode)
      : freeze?.policy.mode;
    const expectedModel = parentDir
      ? (freeze?.policy.calibrationModel ?? freeze?.policy.model)
      : freeze?.policy.model;
    if (
      freeze &&
      (expectedMode !== (submission.sections ? 'whole-song' : 'internal-breaks') ||
        expectedModel !== submission.model)
    )
      throw Error('留出评估使用已冻结的规划方法。');
    const next = submission.sections
      ? wholeSongPlan(source.measures, submission.sections, submission.model)
      : planAccompanimentBreaks(plan, spans, submission.decisions, submission.model);
    let calibration = { round: 0 };
    if (parentDir) {
      const parent = await load(join(parentDir, 'decision.json')).catch(async (error) => {
        if (error.code !== 'ENOENT' || freeze?.policy.mode !== 'rule') throw error;
        return load(join(parentDir, 'evidence.json'));
      });
      const round = (parent.calibration?.round ?? 0) + 1;
      if (
        parent.sourceSha256 !== sourceSha256 ||
        JSON.stringify(parent.freeze) !== JSON.stringify(freeze) ||
        round > 2 ||
        typeof submission.feedback !== 'string' ||
        !submission.feedback.trim()
      )
        throw Error('Revision requires same work, a singer comment, and at most two rounds.');
      calibration = {
        round,
        feedback: submission.feedback,
        parentScoreSha256: createHash('sha256')
          .update(await readFile(join(parentDir, 'arrangement.json')))
          .digest('hex'),
      };
    } else if (submission.feedback) throw Error('Provide the previous candidate for a calibrated revision.');
    const { arrangeV2 } = await vite.ssrLoadModule('/src/lib/arrangeV2.ts');
    const { validateProject } = await vite.ssrLoadModule('/src/lib/music.ts');
    const project = arrangeV2(source, options, next);
    const events = (p) => p.notes.map(({ id, ...event }) => event);
    const controls = (p) => [
      p.key,
      p.timeSignature,
      p.tempo,
      p.measures,
      p.arrangement.options,
      p.chords,
      p.parts.map((v) => [v.id, v.program, v.volume, v.pan]),
      events(p.parts[0]),
    ];
    if (JSON.stringify(controls(project)) !== JSON.stringify(controls(baseline)))
      throw Error('Source, Solo or audition settings differ.');
    const backgroundChanged =
      JSON.stringify(project.parts.slice(1).map(events)) !==
      JSON.stringify(baseline.parts.slice(1).map(events));
    const errors = validateProject(project);
    if (errors.length) throw Error(errors.join(', '));
    await publishScore(vite, out, source, project, {
      'decision.json': {
        ...submission,
        ...(freeze ? { freeze } : {}),
        backgroundChanged,
        calibration,
        decisionSha256: createHash('sha256').update(decisionBytes).digest('hex'),
        spans,
      },
    });
  }
} finally {
  await vite.close();
}
