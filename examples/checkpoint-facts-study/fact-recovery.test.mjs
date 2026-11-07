import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const fixture = new URL('./fact-process.mjs', import.meta.url);
const matrix = [
  ['parent-waiting-facts', 'not-dispatched', 0, 0],
  ['parent-waiting-events', 'not-dispatched', 0, 0],
  ['parent-waiting-before-head', 'not-dispatched', 0, 0],
  ['parent-waiting-head', 'not-dispatched', 0, 0],
  ['parent-waiting-committed', 'rejected', 0, 0],
  ['effect-no-child', 'rejected', 1, 0],
  ['child-finish-before-head', 'completed', 1, 1],
  ['child-finish-committed', 'completed', 1, 1],
  ['parent-accept-facts', 'completed', 1, 2],
  ['parent-accept-events', 'completed', 1, 2],
  ['parent-accept-head', 'completed', 1, 2],
  ['parent-accept-committed', 'completed', 1, 1],
  ['parent-failed-before-head', 'completed', 1, 1],
  ['parent-failed-committed', 'terminal', 1, 0],
  ['root-finish-before-head', 'completed', 1, 1],
  ['root-finish-committed', 'terminal', 1, 1],
];

for (const [cut, status, effects, mappings] of matrix)
  test(`fact/head fresh-process recovery: ${cut}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-fact-cut-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    const run = spawnSync(process.execPath, [fixture.pathname, 'run', path, cut], { encoding: 'utf8' });
    assert.equal(run.status, 73, run.stderr || run.stdout);
    const resumed = spawnSync(process.execPath, [fixture.pathname, 'resume', path], { encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.status, status, JSON.stringify(result));
    const counts = Object.fromEntries(result.effects.map((row) => [row.kind, row.n]));
    assert.equal(counts.effect ?? 0, effects);
    assert.equal(counts.mapping ?? 0, mappings);
    if (status === 'completed') {
      assert.equal(result.root, 'succeeded');
      const again = spawnSync(process.execPath, [fixture.pathname, 'resume', path], { encoding: 'utf8' });
      assert.equal(again.status, 0, again.stderr);
      const terminal = JSON.parse(again.stdout);
      assert.equal(terminal.status, 'terminal');
      assert.deepEqual(terminal.effects, result.effects, 'Terminal restoration cannot repeat effects or mappings');
    }
  });
