// Publish two nested comparisons: source-backed writing, then its shortened form.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'vite';
import { publishScore } from './audition-score.mjs';
const [draftDir, out] = process.argv.slice(2);
if (!draftDir || !out) throw Error('Expected baseline draft directory and a fresh output directory.');
const read = async (file) => JSON.parse(await readFile(join(draftDir, file), 'utf8'));
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  appType: 'custom',
});
try {
  const { writeInstrumentalLines, condenseInstrumentalRepeats } = await vite.ssrLoadModule(
    '/src/lib/instrumentalWriting.ts',
  );
  const source = await read('source.json'),
    baseline = await read('arrangement.json');
  const { project, gestures } = writeInstrumentalLines(source, baseline);
  const { project: compact, cuts, segments } = condenseInstrumentalRepeats(source, project);
  console.log(
    JSON.stringify({
      gestures: gestures.length,
      underSolo: gestures.filter((g) => g.sung).length,
      measures: [baseline.measures, compact.measures],
      cuts,
    }),
  );
  await publishScore(vite, join(out, 'writing'), source, project, { 'writing.json': gestures });
  if (cuts.length) {
    const { applyFormCuts } = await vite.ssrLoadModule('/src/lib/arrangementForm.ts');
    const cutSource = applyFormCuts(source, cuts, {
      leadPartId: baseline.arrangement.options.leadPartId,
    }).project;
    await publishScore(vite, join(out, 'compact'), cutSource, compact, { 'form.json': { cuts, segments } });
  }
} finally {
  await vite.close();
}
