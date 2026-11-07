import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const processFile = fileURLToPath(new URL('./process.mjs', import.meta.url));

// Every launch opens a fresh process and fresh runtime. The original process
// exits without finally at a cut; neither an old Work nor an old endpoint is reused.
export function launch(action, directory, mode, options = {}) {
  const child = spawnSync(process.execPath, [processFile, action, directory, mode, JSON.stringify(options)], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(child.error);
  if (options.cut && action !== 'inspect') {
    assert.equal(child.status, 73, child.stderr || child.stdout);
    return child.stdout.trim() ? JSON.parse(child.stdout) : null;
  }
  assert.ok([0, 1].includes(child.status), child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(child.status, report.status === 'failed' ? 1 : 0, child.stderr || child.stdout);
  return report;
}

export function studyDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-recovery-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function count(report, kind) {
  return report.events.filter((event) => event.kind === kind).length;
}

export const modes = Object.freeze(['explicit', 'replay']);
export const cuts = Object.freeze(['child-finish', 'entity-applied', 'group-accepted', 'root-accepted', 'preview-pending', 'preview-emitted', 'previewed']);
export const faults = Object.freeze(['resource-close', 'child-finish-ack', 'strict-observation', 'strict-checkpoint', 'cancel-after-preview']);
