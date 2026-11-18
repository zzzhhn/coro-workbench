import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function implementationHash() {
  const libs = (await readdir(join(root, 'src/lib')))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => 'src/lib/' + f);
  const scripts = (await readdir(join(root, 'scripts')))
    .filter((f) => /audition.*\.mjs$/.test(f))
    .map((f) => 'scripts/' + f);
  const files = [...libs, ...scripts, 'package-lock.json'].sort();
  const hashes = [];
  for (const file of files) hashes.push([file, digest(await readFile(join(root, file)))]);
  return digest(JSON.stringify(hashes));
}
function membership(corpus) {
  return ['dev', 'holdout'].map((split) =>
    corpus[split].map(({ id, workId }) => [id, workId]).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export async function checkFreeze(receipt, corpus) {
  if (
    receipt.implementationSha256 !== (await implementationHash()) ||
    (corpus && JSON.stringify(receipt.membership) !== JSON.stringify(membership(corpus)))
  )
    throw Error('冻结后实现或开发／留出分组已改变。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [corpusFile, policyFile, target] = process.argv.slice(2);
  if (!target) throw Error('Expected private corpus, chosen policy JSON, new freeze receipt path.');
  const corpus = JSON.parse(await readFile(corpusFile, 'utf8'));
  const policy = JSON.parse(await readFile(policyFile, 'utf8'));
  if (
    !['rule', 'whole-song', 'internal-breaks'].includes(policy.mode) ||
    !policy.instructions?.trim() ||
    (policy.mode !== 'rule' && !policy.model?.trim())
  )
    throw Error('Identify the selected planner, model and fixed instructions.');
  const receipt = {
    version: 1,
    frozenAt: new Date().toISOString(),
    implementationSha256: await implementationHash(),
    membership: membership(corpus),
    policy,
  };
  await writeFile(target, JSON.stringify(receipt, null, 2), { flag: 'wx' });
}
