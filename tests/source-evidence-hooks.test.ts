import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// A hook after a conditional return changes hook order when a project with
// analysis replaces one without it ("Rendered more hooks than during the
// previous render"), which crashed the workbench after a finished upload.
test('SourceEvidence calls every hook before its early return', () => {
  const source = readFileSync(new URL('../src/components/SourceEvidence.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export default function SourceEvidence'));
  const earlyReturn = body.search(/\n {2}if \([^\n]*\) return null;/);
  expect(earlyReturn).toBeGreaterThan(0);
  const hooks = [...body.matchAll(/\buse(?:State|Effect|Memo|Callback|Ref|Reducer|LayoutEffect)\(/g)];
  expect(hooks.length).toBeGreaterThan(0);
  expect(hooks.filter((hook) => (hook.index ?? 0) > earlyReturn).map((hook) => hook[0])).toEqual([]);
});
