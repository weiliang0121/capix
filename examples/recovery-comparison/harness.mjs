import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = new URL('./process.mjs', import.meta.url);

export function launch(action, directory, mode, options = {}) {
  const process = spawnSync(globalThis.process.execPath, [fixture.pathname, action, directory, mode, JSON.stringify(options)], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(process.error);
  const expected = options.cut && (action === 'run' || action === 'resume') ? 73 : 0;
  assert.equal(process.status, expected, process.stderr || process.stdout);
  if (expected === 73) return null;
  return JSON.parse(process.stdout);
}

export function studyDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-recovery-comparison-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export const cuts = Object.freeze([
  { cut: 'initial', status: 'completed', model: 1, entity: 1 },
  { cut: 'read-result', status: 'completed', model: 1, entity: 1 },
  { cut: 'model-intent', status: 'rejected', model: 0, entity: 0 },
  { cut: 'model-effect', status: 'completed', model: 1, entity: 1 },
  { cut: 'model-executed-unconfirmed', status: 'rejected', model: 1, entity: 0 },
  { cut: 'child-returned', status: 'completed', model: 1, entity: 1 },
  { cut: 'accept-intent', status: 'rejected', model: 1, entity: 0 },
  { cut: 'entity-effect', status: 'completed', model: 1, entity: 1 },
  { cut: 'entity-executed-unconfirmed', status: 'rejected', model: 1, entity: 1 },
  { cut: 'accepted', status: 'completed', model: 1, entity: 1 },
  { cut: 'final', status: 'terminal', model: 1, entity: 1 },
]);
