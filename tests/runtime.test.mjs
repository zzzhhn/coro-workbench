import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backendMismatch, runtimeIdentity, supportedNode } from '../scripts/runtime.mjs';

test('rejects wrong workspace, stale source and legacy unidentified servers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'coro-runtime-'));
  try {
    mkdirSync(path.join(root, 'server'));
    writeFileSync(path.join(root, 'server/app.py'), 'before');
    const identity = runtimeIdentity(root);
    const health = { localOnly: true, engines: { basicPitch: {} }, runtime: identity };
    assert.equal(backendMismatch(health, identity), undefined);
    assert.match(backendMismatch({ ...health, runtime: undefined }, identity), /无法确认/);
    assert.match(backendMismatch(health, { ...identity, workspaceId: 'elsewhere' }), /另一份/);
    writeFileSync(path.join(root, 'server/app.py'), 'after');
    assert.match(backendMismatch(health, runtimeIdentity(root)), /旧版本/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('matches installed Vite and Vitest Node requirements', () => {
  for (const version of ['22.12.0', '22.18.0', '24.0.0', '26.0.0'])
    assert.equal(supportedNode(version), true);
  for (const version of ['20.19.0', '22.11.0', '23.0.0', '25.5.0'])
    assert.equal(supportedNode(version), false);
});
